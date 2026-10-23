/**
 * `dsh-proxy`: route model-API requests through an HTTP/SOCKS proxy
 * without modifying DeepSeek Harness source. It wraps `globalThis.fetch` —
 * the transport both the DeepSeek adapter and the pi-ai SDK clients use — and
 * decides, per host, whether a request takes the proxy or this plugin's hardened
 * direct channel. A host on the force list always takes the proxy; every other
 * host starts direct and moves onto the proxy only when direct does not answer
 * within a second or fails outright, and the channel that answers is kept for
 * the session (see `dsh-proxy/routing`).
 *
 * The settings seam is DSH 0.1.7's: a `volatile()` config field is edited in
 * place by the settings document, so the running instance re-reads the value
 * on `loader/volatile-update` rather than being remounted. `apply` is
 * therefore installed once and {@link readConfig} is consulted per refresh.
 * @module dsh-proxy
 */

import { appendFileSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls in the `Context.settings` augmentation without importing a
// value, so the module's named exports are not part of this module's link step.
import type {} from '@deepseek-ai/dsh-settings'
// Type-only: declares the `session/created` event this plugin resets on.
import type {} from '@deepseek-ai/dsh-session'
// Type-only: declares the `loader/volatile-update` event below.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { assertValid, Config, isValidSubprocessProxy, readConfig } from './config.js'
import type { HttpProxyConfig, PluginConfig } from './config.js'
import {
  createHardenedChannel,
  createRoutingFetch,
  isExemptHostname,
  isLoopbackHostname,
  normalizeHostEntry,
  shouldForceProxy,
} from './proxy.js'
import type { HardenedChannel } from './proxy.js'
import {
  RoutingDispatcher,
  installGlobalDispatcher,
  uninstallGlobalDispatcher,
} from './dispatch.js'
import { describeStability, stabilityIsDefault } from './stability.js'
import type { StabilityConfig } from './stability.js'
import { observerFromEnv } from './observe.js'
import type { ProxyObserver } from './observe.js'
import { PROBE_TIMEOUT_MS, RouteMemory, describeRouting } from './routing.js'
import type { RouteAttempt, RouteChannel } from './routing.js'
import type { RetryAttempt } from './retry.js'
import { planRowCleanup, pruneProxyEntryFromProfile, stripProxyEntryConfigFromProfile } from './profile-patch.js'
import { installSystemProxyRpc } from './rpc.js'
import type { SystemProxyReading } from './rpc-contract.js'
import { readSystemProxy } from './system-proxy.js'

export { Config, SUBPROCESS_PROXY_SCHEMES, assertValid, isValidSubprocessProxy, readConfig, SUPPORTED_PROXY_SCHEMES } from './config.js'
export type { HttpProxyConfig, PluginConfig } from './config.js'
export {
  createHardenedChannel,
  createProxyFetch,
  createRoutingFetch,
  headerPairs,
  hostnameOf,
  isLanHostname,
  isLoopbackHostname,
  matchesHostEntry,
  normaliseFetchCall,
  normalizeHostEntry,
  shouldForceProxy,
  urlOf,
} from './proxy.js'
export type { ChannelOptions, HardenedChannel, NormalisedCall, ProxyFetch, RoutingOptions } from './proxy.js'
export {
  RoutingDispatcher,
  installGlobalDispatcher,
  isExemptHostname,
  liveDispatcherCount,
  uninstallGlobalDispatcher,
} from './dispatch.js'
export type { RoutingInput } from './dispatch.js'
export {
  DEFAULT_STABILITY,
  HAPPY_EYEBALLS_ATTEMPT_MS,
  POOLED_IDLE_MAX_MS,
  POOLED_IDLE_WINDOW_MS,
  STABILITY_BOUNDS,
  STABILITY_FIELDS,
  TCP_KEEPALIVE_DELAY_MS,
  agentOptionsOf,
  connectorOptionsOf,
  describeStability,
  readStability,
  stabilityIsDefault,
} from './stability.js'
export type { HardenedAgentOptions, HardenedConnectOptions, StabilityConfig, StabilityField } from './stability.js'
export { ProxyObserver, observerFromEnv } from './observe.js'
export type {
  ObservedChannel,
  ObserverOptions,
  ObserverStats,
  ObserverSummary,
  RequestSample,
} from './observe.js'
export {
  FIRST_CHANNEL,
  PROBE_TIMEOUT_CODE,
  PROBE_TIMEOUT_MS,
  RouteMemory,
  describeRouting,
  otherChannel,
} from './routing.js'
export type { RouteAttempt, RouteChannel, RouteDecision, RouteState } from './routing.js'
export {
  isAborted,
  isReplayableRequest,
  isRetryableTransportError,
  transportCodeOf,
  withTransportRetry,
} from './retry.js'
export type { RetryAttempt, RetryPolicy } from './retry.js'
export {
  PROXY_ENV_NAMES,
  WINDOWS_INTERNET_SETTINGS_KEY,
  normalizeProxyValue,
  parseGsettingsValue,
  parseScutilProxy,
  parseWindowsProxyServer,
  parseWindowsRegistry,
  pickWindowsProxy,
  readEnvironmentProxy,
  readMacSystemProxy,
  readSystemProxy,
  readWindowsSystemProxy,
} from './system-proxy.js'
export type {
  ScutilReading,
  WindowsProxyEntry,
  WindowsProxyRegistry,
} from './system-proxy.js'
export {
  SYSTEM_PROXY_CHANNEL,
  SYSTEM_PROXY_ENDPOINT,
  SYSTEM_PROXY_ROUTE,
} from './rpc-contract.js'
export type {
  ClientRequestEnvelope,
  RpcFailure,
  RpcResult,
  ServerResponseEnvelope,
  SystemProxyReading,
  SystemProxySource,
} from './rpc-contract.js'
export { installSystemProxyRpc } from './rpc.js'
export {
  PROFILE_MANIFEST_FILE,
  PROFILE_PATCH_FILE,
  PROXY_ENTRY_ID,
  PROXY_IDENTITIES,
  PROXY_PACKAGE_NAME,
  planRowCleanup,
  profileDir,
  profileManifestPath,
  profilePatchPath,
  pruneProxyEntry,
  pruneProxyEntryFromProfile,
  readBundleSelection,
  readProxyEntryState,
  stripProxyEntryConfig,
  stripProxyEntryConfigFromProfile,
} from './profile-patch.js'
export type {
  BundleSelection,
  PatchPruneResult,
  PatchStripResult,
  ProxyIdentity,
  ProxyRowCleanup,
  ProxyRowState,
} from './profile-patch.js'

/** Plugin short name (also the profile entry id that carries its settings). */
export const name = 'dsh-proxy'

/**
 * Loopback entries this plugin always adds to a child's `NO_PROXY`.
 *
 * Without them, a child that honors the environment would send the harness's
 * own loopback traffic (Web UI, Connection transport, local test servers)
 * through the proxy and close a loop — the same reason {@link
 * isLoopbackHostname} keeps it direct in-process. `::1` and `[::1]` are both
 * listed because undici reads a bare `::1` as host `:` on port `1` and would
 * never bypass it.
 */
const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1', '[::1]'] as const

/**
 * The environment names the subprocess export writes, per policy field.
 *
 * Both casings are written for every field, exactly as DeepSeek Harness's
 * own `@deepseek-ai/dsh-http-proxy` does, because the readers disagree on
 * which one they prefer: undici reads the lowercase spelling first, while a
 * Windows environment is a single case-insensitive variable, so writing both
 * spellings costs nothing there and keeps the export correct on POSIX.
 */
const SUBPROCESS_ENV_NAMES = {
  httpProxy: ['http_proxy', 'HTTP_PROXY'],
  httpsProxy: ['https_proxy', 'HTTPS_PROXY'],
  noProxy: ['no_proxy', 'NO_PROXY'],
} as const

/**
 * The flag that makes a child Node honor the proxy environment.
 *
 * Written only beside a URL the child can parse. The flag makes Node build a
 * proxy dispatcher from the environment at start-up, and a value it cannot
 * parse — a bare `notaurl`, or a scheme its env-proxy support rejects — stops
 * the child before it runs. `pnpm`, the program this export exists for, is a
 * Node program.
 */
const NODE_USE_ENV_PROXY = 'NODE_USE_ENV_PROXY'

/**
 * The `NO_PROXY` value a child receives: loopback plus whatever the machine
 * already exported.
 *
 * There is no list to fold in any more: the only list the plugin still has is
 * the force list, and a child that inherited the proxy for a pinned host is
 * exactly what the export is for. `NO_PROXY` matching is the umbrella idea one
 * level up — a name covers itself and its subdomains — so the machine's own
 * entries carry over unchanged, and a name the child's matcher cannot express
 * bypasses nothing rather than everything.
 * @param pristine - the machine's own environment, or `undefined` before the
 * first claim captured it (in which case there is nothing of its own to keep).
 * @returns the comma-separated bypass list.
 */
function noProxyValue(
  pristine: ReadonlyMap<string, string | undefined> | undefined,
): string {
  const entries = new Set<string>(LOOPBACK_NO_PROXY)
  // Keep what the machine already exported: the user's own bypass list is
  // not this plugin's to discard. Either casing is read, because a POSIX
  // environment distinguishes them and the machine's own spelling is not
  // this plugin's to guess.
  for (const name of SUBPROCESS_ENV_NAMES.noProxy) {
    const existing = pristine?.get(name)
    if (existing === undefined) continue
    for (const entry of existing.split(',')) {
      const trimmed = entry.trim()
      if (trimmed.length > 0) entries.add(trimmed)
    }
  }
  return [...entries].join(',')
}

/**
 * Live routing wrappers, oldest first. `globalThis.fetch` is the newest of
 * them.
 *
 * Each instance captures the fetch it saw when it mounted, so a teardown that
 * restored its own capture would hand the global back to a *previous*
 * instance's wrapper — whose dispatcher that instance had already closed,
 * leaving every later request to fail with `UND_ERR_DESTROYED`. Keeping the
 * live wrappers in one stack means a teardown only ever re-points the global
 * at another live wrapper, or at the fetch that was in place before the first
 * one.
 */
const liveWrappers: { token: symbol; wrapper: typeof fetch }[] = []

/**
 * The fetch that requests which stay direct fall through to: the one in place
 * before any of this module's wrappers, so instances never chain through each
 * other. Dropped when the last wrapper goes, so a later mount captures
 * whatever is current then.
 */
let baseFetch: typeof fetch | undefined

/** Whether a fetch is one this module installed. */
function isLiveWrapper(candidate: typeof fetch): boolean {
  return liveWrappers.some((entry) => entry.wrapper === candidate)
}

/**
 * Publish a wrapper as the newest one, remembering the fetch it replaced if it
 * is the first.
 * @param token - the installing instance's handle, for {@link uninstallWrapper}.
 * @param wrapper - the routing fetch to install.
 */
function installWrapper(token: symbol, wrapper: typeof fetch): void {
  liveWrappers.push({ token, wrapper })
  globalThis.fetch = wrapper
}

/**
 * Retire a wrapper, re-pointing the global at the newest one still live — or
 * back at the fetch that preceded them all when none is.
 *
 * The global is only touched while it is still one of ours: another plugin may
 * have replaced it since, and that replacement is not this module's to undo.
 * @param token - the handle {@link installWrapper} returned.
 */
function uninstallWrapper(token: symbol): void {
  const index = liveWrappers.findIndex((entry) => entry.token === token)
  if (index === -1) return
  const removed = liveWrappers[index]
  liveWrappers.splice(index, 1)
  if (removed !== undefined && globalThis.fetch !== removed.wrapper && !isLiveWrapper(globalThis.fetch)) return
  const newest = liveWrappers[liveWrappers.length - 1]
  if (newest !== undefined) {
    globalThis.fetch = newest.wrapper
    return
  }
  const base = baseFetch
  baseFetch = undefined
  if (base !== undefined) globalThis.fetch = base
}

/**
 * Live claims on the subprocess export, newest last.
 *
 * `process.env` is process-wide while a plugin instance is not: the loader
 * mounts and disposes entries concurrently, so two instances can be alive at
 * once and either may unload first. A snapshot private to one instance would
 * then let the one unloading delete what the other had written, and leave the
 * survivor's address behind for good. So every instance registers a claim
 * here and the environment is derived from the newest one; withdrawing a claim
 * re-derives it from whatever is left, and the machine's own values come back
 * only when the last claim goes.
 */
const exportClaims = new Map<symbol, { proxyUrl: string }>()

/**
 * The machine's own environment, captured once before the first claim wrote,
 * and dropped when the last claim is withdrawn.
 *
 * It is the merge base for `NO_PROXY`, not the live environment: reading the
 * live one would make a later claim inherit the previous claim's entries,
 * which then could never be removed.
 */
let pristineEnv: Map<string, string | undefined> | undefined

/** Every name the export writes, both casings included. */
const EXPORT_ENV_NAMES: readonly string[] = [
  ...SUBPROCESS_ENV_NAMES.httpProxy,
  ...SUBPROCESS_ENV_NAMES.httpsProxy,
  ...SUBPROCESS_ENV_NAMES.noProxy,
  NODE_USE_ENV_PROXY,
]

/**
 * Write the environment for the newest claim, or put the machine's own back
 * when there is none left.
 */
function applyExport(): void {
  let newest: { proxyUrl: string } | undefined
  for (const claim of exportClaims.values()) newest = claim
  if (newest === undefined) {
    const pristine = pristineEnv
    if (pristine === undefined) return
    pristineEnv = undefined
    for (const [name, value] of pristine) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
    return
  }
  const noProxy = noProxyValue(pristineEnv)
  for (const name of SUBPROCESS_ENV_NAMES.httpProxy) process.env[name] = newest.proxyUrl
  for (const name of SUBPROCESS_ENV_NAMES.httpsProxy) process.env[name] = newest.proxyUrl
  for (const name of SUBPROCESS_ENV_NAMES.noProxy) process.env[name] = noProxy
  process.env[NODE_USE_ENV_PROXY] = '1'
}

/**
 * Export the resolved proxy to child processes through `process.env`.
 *
 * This is the only channel that reaches `pnpm` and `git`: they read the
 * environment, not this plugin's wrapped `fetch`, so plugin installation and
 * update stay direct without it. The values are written to `process.env`
 * itself, which is what DSH's own spawn paths copy into a child (see
 * `scrubbedParentEnv` in `@deepseek-ai/dsh-subprocess`) — including the
 * `pnpm` spawn of the plugin manager, so an install inherits this routing.
 *
 * A URL a child cannot parse is never written, because the flag beside it
 * would then stop that child at start-up and break plugin installation
 * outright. Callers check {@link isValidSubprocessProxy} first, and an invalid
 * URL leaves the environment untouched.
 * @param proxyUrl - the resolved proxy URL (already known to be valid).
 * @returns a token identifying this claim, for {@link releaseSubprocessExport}.
 */
function claimSubprocessExport(
  proxyUrl: string,
): symbol {
  if (pristineEnv === undefined) {
    const pristine = new Map<string, string | undefined>()
    for (const name of EXPORT_ENV_NAMES) pristine.set(name, process.env[name])
    pristineEnv = pristine
  }
  const token = Symbol('dsh-proxy subprocess export')
  exportClaims.set(token, { proxyUrl })
  applyExport()
  return token
}

/**
 * Withdraw one claim on the subprocess export.
 *
 * The environment is re-derived from the remaining claims, and only the last
 * withdrawal puts the machine's own values back — so one instance unloading
 * can never revoke an export another instance still holds. A name that did not
 * exist is deleted rather than blanked: an empty `HTTP_PROXY` is not the same
 * as an absent one, and a child that reads the empty string sees a proxy it
 * cannot parse.
 * @param token - the claim to withdraw.
 * @returns whether the claim was still held.
 */
function releaseSubprocessExport(token: symbol): boolean {
  if (!exportClaims.delete(token)) return false
  applyExport()
  return true
}
/**
 * Collect the one hostname set a routing decision is made from: the force list.
 *
 * It is the only list left. A pinned host always travels through the proxy; every
 * other host is decided once by `RouteMemory` and then kept on the channel that
 * answered (see `dsh-proxy/routing`), so there is no second list to judge against
 * and no exclusion to subtract — the settings page can promise exactly that.
 *
 * Every entry is an umbrella: `a.b` covers `a.b` and the whole subtree under it
 * (see `matchesHostEntry`), so a domain is named once rather than per endpoint.
 * @param config - the current plugin configuration.
 * @returns the pinned entry set.
 */
function collectForceHosts(config: HttpProxyConfig): Set<string> {
  // Entries are normalized so mixed case, `host:port`, pasted URLs, and
  // `*.domain` / `.domain` spellings all land on the same umbrella.
  const force = new Set<string>()
  for (const host of config.forceHosts) {
    const normalized = normalizeHostEntry(host)
    if (normalized !== undefined) force.add(normalized)
  }
  return force
}

/** Whether two hostname sets hold the same hosts (sets are small; order-free compare). */
function sameHostSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false
  for (const host of left) {
    if (!right.has(host)) return false
  }
  return true
}

/**
 * Whether two stability snapshots would build the same channels.
 *
 * A connection pool carries the timeouts it was built with, so a change to any
 * of them has to rebuild. Together with the proxy address and the force list
 * this decides whether a volatile update touches the request path at all: an
 * unrelated edit must not re-dial every idle connection. The retry budget is
 * part of the identity too — the routing wrapper is built from it, so an edit to
 * `retryCount` has to reach the next request.
 * @param left - the settings the live generation was built from.
 * @param right - the settings the current configuration resolves to.
 * @returns whether the live channels may be kept.
 */
function sameStability(left: StabilityConfig, right: StabilityConfig): boolean {
  return left.connectTimeoutMs === right.connectTimeoutMs
    && left.responseTimeoutMs === right.responseTimeoutMs
    && left.streamIdleTimeoutMs === right.streamIdleTimeoutMs
    && left.retryCount === right.retryCount
    && left.retryDelayMs === right.retryDelayMs
    && left.retryOnPossibleDelivery === right.retryOnPossibleDelivery
}

/** Where the record file lives when the environment does not name one. */
export function defaultRecordPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME.length > 0
    ? env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'dsh-proxy.log')
}

/** The size above which the record file is rolled over to `<path>.1`. */
const RECORD_MAX_BYTES = 4 * 1024 * 1024

/** Read one volatile boolean field, tolerating a configuration that predates it. */
function liveFlag(reference: unknown): boolean {
  const field = reference as { get?: () => unknown } | undefined
  try {
    return field !== undefined && typeof field.get === 'function' && field.get() === true
  } catch {
    return false
  }
}

/**
 * Where one record line goes: the host log, and — while the switch is on — a
 * file beside it.
 *
 * The file is the point. The desktop build's host log is not written anywhere
 * the user can read, so without it the record the routing decision produces —
 * which channel each attempt took, whether it settled the host, and why it
 * failed — is invisible exactly when it matters. Writing it is therefore a **switch**: `debugLog` in the settings
 * page, read live, so turning it on records the next attempt without a restart.
 * A non-empty `DSH_PROXY_LOG` turns it on too, for capturing a start-up that
 * never gets as far as the settings page, and overrides the path.
 *
 * The file is capped: past {@link RECORD_MAX_BYTES} it is rolled to `<path>.1`
 * and started fresh, so a long capture cannot fill a disk. A write failure is
 * swallowed for the same reason the plugin never fails a request over a
 * diagnostic.
 * @param ctx - the Cordis context, for the logger.
 * @param enabled - reads the live switch.
 * @returns the sink every record line goes through.
 */
function recordSink(ctx: Context, enabled: () => boolean): (line: string) => void {
  const configured = (process.env.DSH_PROXY_LOG ?? '').trim()
  const forcedByEnv = configured.length > 0
  const file = forcedByEnv ? configured : defaultRecordPath()
  let announced = false
  return (line) => {
    ctx.logger.info('%s', line)
    if (!forcedByEnv && !enabled()) {
      announced = false
      return
    }
    try {
      if (!announced) {
        announced = true
        appendFileSync(file, 'dsh-proxy: record on — appending to ' + file + '\n', 'utf8')
      }
      const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0
      if (size > RECORD_MAX_BYTES) renameSync(file, file + '.1')
      appendFileSync(file, line + '\n', 'utf8')
    } catch {
      /* a record that cannot be written is not a reason to fail the request */
    }
  }
}

/**
 * One failure message, flattened onto a single log line and cut to a readable
 * length. A message is the only clue a failure without a transport code leaves,
 * and a multi-line one would split the record it belongs to.
 * @param message - the error's message.
 * @returns the text for the log line.
 */
function oneLine(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim()
  return flat.length > 160 ? flat.slice(0, 157) + '...' : flat
}

/**
 * Build this instance's per-attempt recorder.
 *
 * The user asked for the decision to be visible, so every attempt is written
 * down: which channel it took, which attempt it was, what it cost, and what that
 * bought — a probe that passed and settled the host, a channel kept because it
 * already answered, or the channel the next attempt will try. A successful first
 * attempt is the common case and stays a single short line; the interesting shape
 * (direct silent, proxy answering) is exactly the pair of lines that explains a
 * bad path. A failure with no transport code carries its message instead, so a
 * code-less error is never invisible.
 * @param ctx - the Cordis context, for the logger.
 * @returns the recorder handed to the routing wrapper.
 */
function makeAttemptRecorder(sink: (line: string) => void): (attempt: RouteAttempt) => void {
  return (attempt) => {
    const code = attempt.code !== undefined && attempt.code.length > 0 ? attempt.code : ''
    const detail = code.length > 0
      ? ' ' + code
      : attempt.message !== undefined && attempt.message.length > 0
        ? ' (' + oneLine(attempt.message) + ')'
        : ''
    const outcome = attempt.ok ? 'ok' : 'failed' + detail
    const decision = attempt.ok
      ? (attempt.probe !== true
        ? 'kept on ' + attempt.channel
        : 'probe passed, ' + attempt.channel + ' kept for this host')
      : attempt.code === 'UND_ERR_ABORTED'
        // The harness cancelling a request (Stop, or the process shutting down)
        // is not the channel's verdict, so it must not read like one.
        ? 'cancelled by the caller'
        : attempt.next === undefined
          ? 'no attempts left'
          : 'next attempt via ' + attempt.next
    sink(
      'dsh-proxy: ' + (attempt.hostname.length > 0 ? attempt.hostname : '(unparseable url)')
      + ' attempt ' + String(attempt.attempt) + '/' + String(attempt.maxAttempts)
      + ' via ' + attempt.channel + ' -> ' + outcome
      + ' in ' + String(attempt.ms) + 'ms (' + decision + ')',
    )
  }
}

/**
 * Build this instance's transport-retry reporter.
 *
 * A retry is worth a warning — it means a connection was dropped and re-dialled
 * — but a gateway that is shedding connections would otherwise fill the log, so
 * the report is throttled per transport code: one repeated code is noise, a new
 * code is news.
 * @param ctx - the Cordis context, for the logger.
 * @returns the reporter handed to both channels.
 */
function makeRetryReporter(ctx: Context): (attempt: RetryAttempt) => void {
  const lastSeen = new Map<string, number>()
  const windowMs = 60_000
  return (attempt) => {
    const now = Date.now()
    if (now - (lastSeen.get(attempt.code) ?? 0) < windowMs) return
    lastSeen.set(attempt.code, now)
    ctx.logger.warn(
      'dsh-proxy: transport retry %d/%d after %s (%s)',
      attempt.attempt,
      attempt.maxRetries,
      attempt.code,
      attempt.url,
    )
  }
}

/**
 * Install the two interception layers — the process-wide dispatcher and the
 * routing `fetch` — plus the Connection channel that lets the settings page
 * read this machine's proxy.
 *
 * Why both layers: the dispatcher covers callers that captured `fetch` or use
 * undici directly, and the wrapper covers callers that pass their own
 * dispatcher; between them, every in-process request takes this plugin's
 * decision, and every one travels on a hardened channel. The configuration is
 * re-read per refresh, so a settings change reaches the next request without a
 * restart; an empty `proxy` deactivates routing and restores both globals, and
 * `useSystemProxy` exchanges the typed address for the machine's own.
 * @param ctx - the Cordis context this plugin mounts into.
 * @param config - the parsed plugin config; its fields are live references.
 */
export function apply(ctx: Context, config: PluginConfig): void {
  /**
   * The active generation: the settings it was built from and the routing
   * dispatcher holding both channels.
   *
   * `stability` is part of the identity on purpose. A connection pool carries
   * the timeouts it was built with, so a timeout edit must rebuild; an
   * unrelated volatile update must not, because a rebuild re-dials every idle
   * connection.
   */
  let active: {
    proxyUrl: string
    force: Set<string>
    stability: StabilityConfig
    routing: RoutingDispatcher
    memory: RouteMemory
  } | undefined
  /** This instance's live global-dispatcher install, when it holds one. */
  let dispatcherInstalled: symbol | undefined
  let disposed = false
  /**
   * This instance's live wrapper, when it has one installed. Held as the stack
   * handle so teardown retires exactly its own entry (see
   * {@link uninstallWrapper}).
   */
  let installed: symbol | undefined
  /**
   * This instance's claim on the process-wide subprocess export, when it holds
   * one. The environment itself is derived at module scope from every live
   * claim (see {@link exportClaims}); the token is what lets this instance
   * withdraw its own claim on unload without touching another instance's.
   */
  let subprocess: symbol | undefined
  /**
   * Whether the last refresh saw a configuration that carries nothing: no
   * proxy URL (settings, the system, or `DSH_HTTP_PROXY`), no host entries, and
   * no system-proxy switch.
   */
  let vacant = true
  /**
   * Opt-in request timing (`DSH_PROXY_DEBUG`), one per instance.
   *
   * It outlives a single generation on purpose: a settings refresh must not lose
   * the samples that explain the request before it. Off by default — without the
   * flag nothing subscribes to undici's diagnostics channel and no request is
   * timed at all.
   */
  const sink = recordSink(ctx, () => liveFlag(config.debugLog))
  const observer: ProxyObserver | undefined = observerFromEnv(process.env.DSH_PROXY_DEBUG, {
    log: (line) => ctx.logger.info('%s', line),
    summaryEvery: 20,
  })
  if (observer !== undefined) {
    ctx.logger.info(
      'dsh-proxy: request observation is on (DSH_PROXY_DEBUG) — one line per request, a summary every 20',
    )
  }

  const deactivate = (): void => {
    sink('dsh-proxy: routing deactivated (the wrapper and the dispatcher are being retired)')
    // Retire both global references first, so no request can land on the
    // channels this is about to close. Each slot re-points at another live
    // instance when there is one, so unloading the older of two mounted
    // instances leaves the newer one routing.
    if (installed !== undefined) {
      uninstallWrapper(installed)
      installed = undefined
    }
    if (dispatcherInstalled !== undefined) {
      uninstallGlobalDispatcher(dispatcherInstalled)
      dispatcherInstalled = undefined
    }
    if (active === undefined) return
    const entry = active
    active = undefined
    // Close, never destroy: an in-flight streaming response finishes instead of
    // being cut off by an unload, and a caller that captured the dispatcher
    // keeps working until it lets go.
    void entry.routing.close().catch(() => { /* a closed dispatcher is the goal */ })
  }

  /**
   * Drop this instance's subprocess export, if it still holds one.
   *
   * Called before every new export and on unload, so the environment never
   * carries two generations of values, and so a plugin that is switched off
   * stops steering `pnpm` and `git`. Withdrawing by token keeps this safe when
   * another instance has since taken the export over: in that case this call
   * does nothing, because the live export is no longer ours to remove.
   */
  const dropSubprocess = (): void => {
    if (subprocess === undefined) return
    releaseSubprocessExport(subprocess)
    subprocess = undefined
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

  /**
   * Take this plugin's settings out of the profile patch, leaving the row and
   * its other keys in place.
   *
   * This is what a switch-off through DSH's per-entry key gets: the row must
   * stay, because it carries the `disabled: true` that keeps the entry off, and
   * only its `config` goes (see `stripProxyEntryConfig`).
   * @param why - the trigger, for the log line.
   */
  const stripSettings = (why: string): void => {
    try {
      const outcome = stripProxyEntryConfigFromProfile()
      if (outcome.removed) {
        ctx.logger.info(
          'dsh-proxy: took the %s settings out of the profile patch, keeping its disabled marker (%s, %s)',
          outcome.id ?? 'dsh-proxy',
          why,
          outcome.file,
        )
      }
    } catch (cause) {
      ctx.logger.warn(
        'dsh-proxy: could not clear the settings in the profile patch (%s)',
        cause instanceof Error ? cause.message : String(cause),
      )
    }
  }

  /**
   * The last system-proxy outcome this instance logged, so a settings edit
   * that does not move the reading does not repeat the line.
   */
  let lastSystemReport = ''

  /**
   * Log what the machine's proxy turned out to be, once per distinct outcome.
   * @param system - the reading.
   * @param active - the proxy URL routing actually uses after fallbacks.
   */
  const reportSystemProxy = (system: SystemProxyReading, active: string): void => {
    const report = `${system.source}|${system.proxy}|${active}`
    if (report === lastSystemReport) return
    lastSystemReport = report
    if (system.proxy.length > 0) {
      ctx.logger.info('dsh-proxy: using the system proxy %s (%s)', system.proxy, system.detail)
    } else if (active.length > 0) {
      ctx.logger.info('dsh-proxy: no system proxy was found (%s); using %s', system.detail, active)
    } else {
      ctx.logger.warn(
        'dsh-proxy: the system proxy was requested but none was found (%s); routing stays off',
        system.detail,
      )
    }
  }

  /**
   * Run the profile cleanup the current state calls for, if any.
   *
   * Both moments that clean the profile — the settings becoming empty while the
   * plugin runs, and the fiber unloading — ask {@link planRowCleanup} first,
   * because deleting a row DSH marked `disabled: true` would re-enable the
   * entry its bundle inserts.
   * @param trigger - where the cleanup came from, for the log line.
   */
  const cleanProfileIfOff = (trigger: string): void => {
    let plan: ReturnType<typeof planRowCleanup>
    try {
      plan = planRowCleanup(vacant)
    } catch (cause) {
      ctx.logger.warn(
        'dsh-proxy: could not read the profile (%s)',
        cause instanceof Error ? cause.message : String(cause),
      )
      return
    }
    if (plan === undefined) return
    if (plan.mode === 'remove') scrubProfile(`${trigger}: ${plan.reason}`)
    else stripSettings(`${trigger}: ${plan.reason}`)
  }

  const refresh = (): void => {
    if (disposed) return
    const cfg = readConfig(config, (message) => ctx.logger.warn(message))
    const stability = cfg.stability
    // With "use the system proxy" on, the machine's own configuration is the
    // address: it is read here, so ticking the switch (or replacing the system
    // proxy and reloading the plugin) reaches the next request without a
    // restart. The typed address is the fallback for a machine that has no
    // system proxy, and `DSH_HTTP_PROXY` is the no-file fallback so a
    // deployment can set the proxy without editing settings.
    const system = cfg.useSystemProxy ? readSystemProxy() : undefined
    const detected = system?.proxy ?? ''
    const proxyUrl = detected.length > 0
      ? detected
      : (cfg.proxy.length > 0 ? cfg.proxy : (process.env.DSH_HTTP_PROXY ?? ''))
    if (system !== undefined) reportSystemProxy(system, proxyUrl)
    // Nothing configured at all — no proxy URL, no pinned hosts, no
    // system-proxy switch, and not the subprocess switch — means the profile row
    // carries nothing, so it goes back out (see `scrubProfile`). A row that still
    // holds settings stays. The switch counts as information on purpose: `false`
    // is its default, so a stored `true` is exactly what the row is for, and
    // dropping the row would forget it.
    vacant = proxyUrl.length === 0 && cfg.forceHosts.length === 0
      && !cfg.useSystemProxy && !cfg.proxySubprocesses && !cfg.debugLog
      // A stability value away from its default is information this row
      // carries: it must survive while it is set, and the cleanup rules above
      // must not treat the row as empty.
      && stabilityIsDefault(stability)
    if (proxyUrl.length === 0) {
      deactivate()
      // No address, no export: a child must not inherit a proxy the plugin
      // itself is not routing through.
      dropSubprocess()
      // Nothing to route with: with the settings empty too, the row carries
      // nothing, so it goes — unless DSH's own state says this entry is
      // switched off, in which case the marker has to stay.
      if (vacant) cleanProfileIfOff('cleared settings')
      return
    }
    const force = collectForceHosts(cfg)
    // The child-process export is reconciled on every refresh, not only when
    // the in-process wrapper changes: flipping its own switch must take
    // effect on the next install without a restart. The previous export is
    // dropped first for two reasons — the environment must never carry two
    // generations of values, and the merge below reads the machine's own
    // `NO_PROXY`, which our own write would otherwise shadow and then inherit.
    dropSubprocess()
    if (cfg.proxySubprocesses) {
      if (isValidSubprocessProxy(proxyUrl)) {
        subprocess = claimSubprocessExport(proxyUrl)
      } else {
        // Deliberately not a failure: an address built for SOCKS serves the
        // in-process wrapper but cannot be handed to a Node child without
        // risking its start-up, so the export is skipped and said so.
        ctx.logger.warn(
          'dsh-proxy: cannot export the proxy "%s" to child processes (only http/https works); plugin installs stay direct',
          proxyUrl,
        )
      }
    }
    // No config actually moved: keep the current channels and wrapper, so an
    // unrelated volatile update never tears down in-flight connections. The
    // retry budget is part of the stability snapshot, which is compared here
    // too, so an edit to it reaches the next request.
    if (
      active !== undefined
      && active.proxyUrl === proxyUrl
      && sameHostSet(active.force, force)
      && sameStability(active.stability, stability)
    ) return
    let direct: HardenedChannel
    let proxied: HardenedChannel
    let routing: RoutingDispatcher
    let memory: RouteMemory
    let onAttempt: (attempt: RouteAttempt) => void
    let onRetry: (attempt: RetryAttempt) => void
    try {
      // `assertValid` guards the interactive path, but the `DSH_HTTP_PROXY`
      // fallback bypasses it — judge the resolved URL here too, so a bad value
      // degrades to "routing off" instead of failing the plugin mount.
      assertValid({ proxy: proxyUrl })
      onRetry = makeRetryReporter(ctx)
      // Both channels are this plugin's own: a host the configuration does not
      // name still gets the long connect ceiling and the keepalive, rather than
      // falling back to undici's 10 second connect timeout — the failure this
      // plugin exists to remove. The retry budget is deliberately *not* given to
      // the channels: the routing wrapper runs the loop, because it — not the
      // channel — decides which path each attempt takes (see `dsh-proxy/routing`).
      const observation = observer === undefined ? {} : { observer }
      const channelStability = { ...stability, retryCount: 0 }
      direct = createHardenedChannel(undefined, { stability: channelStability, onRetry, ...observation })
      proxied = createHardenedChannel(proxyUrl, { stability: channelStability, onRetry, ...observation })
      // One memory per generation: which channel a host is on is a function of
      // the answers that generation saw, so a rebuilt generation starts every
      // host from direct again. A new session clears it too (see below).
      memory = new RouteMemory()
      onAttempt = makeAttemptRecorder(sink)
      routing = new RoutingDispatcher({
        direct: direct.dispatcher,
        proxied: proxied.dispatcher,
        // Synchronous and pure by contract: the channel is read from the memory,
        // never advanced here.
        channelFor: (hostname) => isExemptHostname(hostname)
          ? 'direct'
          : shouldForceProxy(hostname, force)
            ? 'proxy'
            : memory.decide(hostname).channel,
        // The dispatcher serves the callers that captured `fetch` before this
        // plugin mounted, so it has to settle the same memory the wrapped path
        // settles — otherwise those callers keep landing on a channel that just
        // failed, which is exactly the "four attempts, none of them connected"
        // shape.
        learnFor: (hostname) => !isExemptHostname(hostname) && !shouldForceProxy(hostname, force),
        onOutcome: (record) => {
          let next: RouteChannel | undefined
          if (record.ok) {
            memory.settle(record.hostname, record.channel)
            next = record.channel
          } else {
            next = memory.failed(record.hostname, record.channel)?.channel
          }
          sink(
            'dsh-proxy: ' + record.hostname + ' via ' + record.channel + ' (dispatcher) -> '
            + (record.ok ? 'ok' : 'failed' + (record.code === undefined || record.code.length === 0 ? '' : ' ' + record.code))
            + ' in ' + String(record.ms) + 'ms ('
            + (record.ok
              ? 'kept on ' + record.channel
              : next === undefined ? 'no further attempt' : 'next via ' + next)
            + ')',
          )
        },
      })
    } catch (cause) {
      ctx.logger.warn(
        'dsh-proxy: invalid proxy URL "%s" (%s); routing stays off',
        proxyUrl,
        cause instanceof Error ? cause.message : String(cause),
      )
      deactivate()
      // Routing is off, so no child may keep inheriting its address either.
      dropSubprocess()
      return
    }
    sink(
      'dsh-proxy: routing generation installed — proxy=' + proxyUrl
      + ' forced=' + String(force.size)
      + ' retry=' + String(stability.retryCount) + 'x' + String(stability.retryDelayMs) + 'ms'
      + ' ' + describeRouting(Math.max(1, 1 + stability.retryCount), PROBE_TIMEOUT_MS),
    )
    const next = { proxyUrl, force, stability, routing, memory }
    const previous = active
    active = next
    // Retire this instance's previous wrapper *before* looking at the global:
    // while we still hold it, it is the top of the stack, so capturing first
    // would record our own wrapper as the fetch this module replaced — and
    // that wrapper's dispatcher is about to close, pinning a dead link to the
    // bottom of the stack that the last teardown would then restore.
    if (installed !== undefined) {
      uninstallWrapper(installed)
      installed = undefined
    }
    // The direct path falls through to the fetch that preceded this module's
    // wrappers, not to whatever instance mounted last: chaining instances
    // would make one instance's teardown break the other's direct requests.
    // Only the first wrapper captures it — an empty stack is exactly what
    // makes `globalThis.fetch` that fetch.
    if (baseFetch === undefined && liveWrappers.length === 0) baseFetch = globalThis.fetch
    // Install the dispatcher first: a library that captured `fetch` before this
    // plugin mounted reaches the network through the global dispatcher, so it
    // must see the new generation from its first request.
    const dispatcherToken = Symbol('dsh-proxy dispatcher')
    installGlobalDispatcher(dispatcherToken, routing)
    dispatcherInstalled = dispatcherToken
    const wrapper = createRoutingFetch({
      proxy: proxied.fetch,
      direct: direct.fetch,
    }, memory, {
      retryCount: stability.retryCount,
      baseDelayMs: stability.retryDelayMs,
      retryOnPossibleDelivery: stability.retryOnPossibleDelivery,
      // The 1-second decision budget: a host that is on no list starts direct
      // and only moves to the proxy when direct stays silent for this long.
      probeTimeoutMs: PROBE_TIMEOUT_MS,
      // The force list, and only the force list: the routing layer applies the
      // built-in loopback/LAN exemption itself, so a pinned name can never be
      // made to leave the machine.
      forcedProxy: (hostname) => shouldForceProxy(hostname, force),
      onAttempt,
      onRetry,
    })
    const token = Symbol('dsh-proxy wrapper')
    installWrapper(token, wrapper)
    installed = token
    ctx.logger.info(
      'dsh-proxy: routing installed — forced hosts %d, %s, %s',
      force.size,
      describeStability(stability),
      describeRouting(Math.max(1, 1 + stability.retryCount), PROBE_TIMEOUT_MS),
    )
    // Publish the new wrapper before closing the old dispatcher, so requests
    // started after this point always land on the live dispatcher.
    if (previous !== undefined) {
      void previous.routing.close().catch(() => { /* replaced by a newer generation */ })
    }
  }

  refresh()
  // The settings page's "use the system proxy" switch reads the machine through
  // this plugin's own Connection channel; a composition without one simply
  // never installs it.
  installSystemProxyRpc(ctx)
  ctx.effect(() => () => {
    disposed = true
    deactivate()
    // The environment is part of what this instance installed: leaving it
    // behind would keep steering `pnpm` and `git` after the plugin is gone.
    dropSubprocess()
    // An unload is not by itself a switch-off: a restart, an HMR reload, and an
    // update tear the fiber down the same way, and paying for that with the
    // user's settings would be worse than leaving the row. `planRowCleanup`
    // reads DSH's own persistent state to tell the two apart — a bundle the
    // profile no longer selects, or a row carrying `disabled: true`.
    cleanProfileIfOff('plugin unloaded')
    // The observer holds a process-wide subscription; it must not outlive the
    // fiber that installed it.
    observer?.dispose()
  })

  // "The first request of a session goes direct": every new conversation starts
  // with an empty memory, so a host that settled on the proxy in the previous
  // conversation probes direct again instead of inheriting that decision.
  ctx.on('session/created', () => {
    active?.memory.reset()
  })

  // DSH edits this plugin's configuration in place: the Loader commits the new
  // volatile snapshots and announces them, and this instance is expected to
  // re-read rather than be remounted.
  ctx.on('loader/volatile-update', () => {
    refresh()
  })
}
