/**
 * `dsh-proxy`: route model-API requests through an HTTP/SOCKS proxy
 * without modifying DeepSeek Harness source. It wraps `globalThis.fetch` —
 * the transport both the DeepSeek adapter and the pi-ai SDK clients use — and
 * sends only model-API hosts through a proxy dispatcher. Web search, web
 * fetch, MCP, and every other host keep the direct path.
 *
 * The settings seam is DSH 0.1.7's: a `volatile()` config field is edited in
 * place by the settings document, so the running instance re-reads the value
 * on `loader/volatile-update` rather than being remounted. `apply` is
 * therefore installed once and {@link readConfig} is consulted per refresh.
 * @module dsh-proxy
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls in the `Context.settings` augmentation without importing a
// value, so the module's named exports are not part of this module's link step.
import type {} from '@deepseek-ai/dsh-settings'
// Type-only: declares the `loader/volatile-update` event below.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { assertValid, Config, readConfig } from './config.js'
import type { HttpProxyConfig, PluginConfig } from './config.js'
import {
  DEFAULT_DEEPSEEK_HOST,
  DEFAULT_MODEL_HOST_SUFFIXES,
  DEFAULT_MODEL_HOSTS,
  createProxyFetch,
  createRoutingFetch,
  hostnameOf,
  normalizeHostEntry,
} from './proxy.js'
import type { ProxyFetch } from './proxy.js'
import { pruneProxyEntryFromProfile } from './profile-patch.js'

export { Config, assertValid, readConfig, SUPPORTED_PROXY_SCHEMES } from './config.js'
export type { HttpProxyConfig, PluginConfig } from './config.js'
export {
  DEFAULT_DEEPSEEK_HOST,
  DEFAULT_MODEL_HOST_SUFFIXES,
  DEFAULT_MODEL_HOSTS,
  createProxyFetch,
  createRoutingFetch,
  hostnameOf,
  matchesHostEntry,
  normalizeHostEntry,
  shouldProxy,
  urlOf,
} from './proxy.js'
export type { ProxyFetch } from './proxy.js'
export {
  PROFILE_PATCH_FILE,
  PROXY_ENTRY_ID,
  PROXY_IDENTITIES,
  PROXY_PACKAGE_NAME,
  profilePatchPath,
  pruneProxyEntry,
  pruneProxyEntryFromProfile,
} from './profile-patch.js'
export type { PatchPruneResult, ProxyIdentity, ProxyRowCleanup } from './profile-patch.js'

/** Plugin short name (also the profile entry id that carries its settings). */
export const name = 'dsh-proxy'

/** The `llm-pi-ai` namespace, read here for its configured gateway hostnames. */
const PI_AI_NS = 'llm-pi-ai'

/** A resolved `llm-pi-ai` section's provider profile subset. */
interface PiAiSection {
  providers?: Record<string, { baseURL?: string }>
}

/**
 * The custom model gateways declared in the `llm-pi-ai` settings section.
 *
 * The section belongs to another plugin, so it is read through the settings
 * service's public `describe()` read rather than injected: this plugin must
 * keep routing with its composition entry even when no settings provider is
 * present, and must not depend on pi-ai's own context.
 * @param ctx - the Cordis context, for the optional settings service.
 * @returns the configured `baseURL`s, malformed ones included (they are
 * pi-ai's to reject, not this plugin's to judge).
 */
function piAiGateways(ctx: Context): string[] {
  const settings = ctx.get('settings')
  if (settings === undefined) return []
  let served
  try {
    served = settings.describe().find((row) => String(row.ns) === PI_AI_NS)
  } catch (cause) {
    // Reading another plugin's section must never cost this plugin its
    // routing: an unsettled settings document simply contributes no gateways.
    ctx.logger.warn(
      'dsh-proxy: cannot read the %s settings section (%s); using the built-in model hosts only',
      PI_AI_NS,
      cause instanceof Error ? cause.message : String(cause),
    )
    return []
  }
  const section = served?.value as PiAiSection | undefined
  return Object.values(section?.providers ?? {})
    .map((profile) => profile.baseURL)
    .filter((baseURL): baseURL is string => typeof baseURL === 'string' && baseURL.length > 0)
}

/**
 * The two umbrella sets one routing decision is made of.
 *
 * They stay apart on purpose: an exclusion is not a subtraction from the
 * routed set (that could only remove an entry spelled identically, so
 * excluding `a.b` would leave `api.a.b` routed), but a second, higher-priority
 * umbrella test at decision time.
 */
interface ProxyTargets {
  /** Entries routed through the proxy. */
  hosts: Set<string>
  /** Entries kept direct, whatever `hosts` says. */
  exclude: Set<string>
}

/**
 * Collect the hostnames that should travel through the proxy: the official
 * DeepSeek host (or `DEEPSEEK_BASE_URL`), the default endpoints of the
 * built-in pi-ai providers (catalog routes configure no `baseURL` of their
 * own), the configured `proxyHosts`, and the custom model gateways declared
 * in the `llm-pi-ai` settings section.
 *
 * Every entry is an umbrella: `a.b` covers `a.b` and the whole subtree under
 * it (see `matchesHostEntry`), so a domain is named once rather than per
 * endpoint.
 * @param ctx - the Cordis context, for the optional settings service.
 * @param config - the current plugin configuration.
 * @returns the routed and excluded entry sets.
 */
function collectProxyHosts(ctx: Context, config: HttpProxyConfig): ProxyTargets {
  const hosts = new Set<string>()
  if (config.proxyHosts.length > 0) {
    // Explicit mode: only the listed domains are proxied. Entries are
    // normalized so mixed case, `host:port`, pasted URLs, and `*.domain` /
    // `.domain` spellings all land on the same umbrella.
    for (const host of config.proxyHosts) {
      const normalized = normalizeHostEntry(host)
      if (normalized !== undefined) hosts.add(normalized)
    }
  } else {
    // Auto mode: every model-API host DSH knows about.
    hosts.add(DEFAULT_DEEPSEEK_HOST)
    // Default endpoints of the installed pi-ai catalog: a catalog route such
    // as `google-vertex` names no baseURL of its own, so its requests land on
    // the catalog's endpoint (region-templated for Vertex and Azure, hence
    // the suffix entries).
    for (const host of DEFAULT_MODEL_HOSTS) hosts.add(host)
    for (const suffix of DEFAULT_MODEL_HOST_SUFFIXES) hosts.add(suffix)
    const deepseekBase = process.env.DEEPSEEK_BASE_URL
    if (deepseekBase !== undefined && deepseekBase.length > 0) {
      try {
        hosts.add(hostnameOf(deepseekBase))
      } catch {
        // A malformed base URL is the adapter's to reject, not this plugin's.
      }
    }
    for (const gateway of piAiGateways(ctx)) {
      try {
        hosts.add(hostnameOf(gateway))
      } catch {
        // Same as above: configuration errors surface where they are written.
      }
    }
  }
  // Exclusions always win, in either mode — the same umbrella, judged first.
  const exclude = new Set<string>()
  for (const host of config.excludeHosts) {
    const normalized = normalizeHostEntry(host)
    if (normalized !== undefined) exclude.add(normalized)
  }
  return { hosts, exclude }
}

/** Whether two hostname sets hold the same hosts (sets are small; order-free compare). */
function sameHostSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false
  for (const host of left) {
    if (!right.has(host)) return false
  }
  return true
}

/** Whether two target pairs would route identically. */
function sameTargets(left: ProxyTargets, right: ProxyTargets): boolean {
  return sameHostSet(left.hosts, right.hosts) && sameHostSet(left.exclude, right.exclude)
}

/**
 * Install the routing wrapper. The configuration is re-read per refresh, so a
 * settings change reaches the next request without a restart; an empty `proxy`
 * deactivates routing and restores the platform fetch.
 * @param ctx - the Cordis context this plugin mounts into.
 * @param config - the parsed plugin config; its fields are live references.
 */
export function apply(ctx: Context, config: PluginConfig): void {
  const originalFetch = globalThis.fetch
  /** The active routing wrapper plus the settings it was built from. */
  let active: { proxyUrl: string; targets: ProxyTargets; entry: ProxyFetch } | undefined
  let disposed = false
  /**
   * Whether the last refresh saw a configuration that carries nothing: no
   * proxy URL (settings or `DSH_HTTP_PROXY`) and no host entries at all.
   */
  let vacant = true

  const deactivate = (): void => {
    if (active === undefined) return
    // Restore the platform fetch first, so no request can land on a closing
    // dispatcher after this point.
    globalThis.fetch = originalFetch
    const entry = active.entry
    active = undefined
    void entry.close().catch(() => { /* a closed dispatcher is the goal */ })
  }

  /**
   * Take the settings row DSH wrote for this plugin back out of the profile
   * patch.
   *
   * A row that outlives its settings is pure residue: it keeps the profile's
   * `cordis.patch.yml` dirty, and disabling the plugin cannot remove it,
   * because DSH only drops the bundle. Failures are logged, never thrown — a
   * stale row is not worth failing a plugin mount over.
   * @param why - the trigger, for the log line.
   */
  const scrubProfile = (why: string): void => {
    try {
      const outcome = pruneProxyEntryFromProfile()
      if (outcome.removed) {
        ctx.logger.info(
          'dsh-proxy: removed the %s settings row from the profile patch (%s, %s)',
          outcome.id ?? 'dsh-proxy',
          why,
          outcome.file,
        )
      }
    } catch (cause) {
      ctx.logger.warn(
        'dsh-proxy: could not clean the settings row (%s)',
        cause instanceof Error ? cause.message : String(cause),
      )
    }
  }

  const refresh = (): void => {
    if (disposed) return
    const cfg = readConfig(config)
    // Settings `proxy` wins; the `DSH_HTTP_PROXY` environment variable is the
    // no-file fallback so a deployment can set the proxy without editing settings.
    const proxyUrl = cfg.proxy.length > 0 ? cfg.proxy : (process.env.DSH_HTTP_PROXY ?? '')
    // Nothing configured at all — no proxy URL, no routed hosts, no
    // exclusions — means the profile row carries no information, so it goes
    // back out (see `scrubProfile`). A row that still holds settings stays.
    vacant = proxyUrl.length === 0 && cfg.proxyHosts.length === 0 && cfg.excludeHosts.length === 0
    if (proxyUrl.length === 0) {
      deactivate()
      if (vacant) scrubProfile('no proxy URL and no host entries')
      return
    }
    const targets = collectProxyHosts(ctx, cfg)
    // No config actually moved: keep the current dispatcher and wrapper, so an
    // unrelated volatile update never tears down in-flight proxy connections.
    if (active !== undefined && active.proxyUrl === proxyUrl && sameTargets(active.targets, targets)) return
    let entry: ProxyFetch
    try {
      // `assertValid` guards the interactive path, but the `DSH_HTTP_PROXY`
      // fallback bypasses it — judge the resolved URL here too, so a bad value
      // degrades to "routing off" instead of failing the plugin mount.
      assertValid({ proxy: proxyUrl })
      entry = createProxyFetch(proxyUrl)
    } catch (cause) {
      ctx.logger.warn(
        'dsh-proxy: invalid proxy URL "%s" (%s); routing stays off',
        proxyUrl,
        cause instanceof Error ? cause.message : String(cause),
      )
      deactivate()
      return
    }
    const next = { proxyUrl, targets, entry }
    const previous = active
    active = next
    globalThis.fetch = createRoutingFetch(entry.fetch, originalFetch, targets.hosts, targets.exclude)
    // Publish the new wrapper before closing the old dispatcher, so requests
    // started after this point always land on the live dispatcher.
    if (previous !== undefined) {
      void previous.entry.close().catch(() => { /* replaced by a newer wrapper */ })
    }
  }

  refresh()
  ctx.effect(() => () => {
    disposed = true
    deactivate()
    // Turning the plugin off (disable, uninstall, or a profile recomposition)
    // leaves nothing behind when the configuration was already empty. With
    // settings still in place the row stays, so mounting the plugin again
    // restores them.
    if (vacant) scrubProfile('plugin unloaded with empty settings')
  })

  // DSH edits this plugin's configuration in place: the Loader commits the new
  // volatile snapshots and announces them, and this instance is expected to
  // re-read rather than be remounted. The proxied host set also depends on the
  // `llm-pi-ai` gateways, another volatile section served by the same Loader
  // path, so one subscription covers both.
  ctx.on('loader/volatile-update', () => {
    refresh()
  })
}
