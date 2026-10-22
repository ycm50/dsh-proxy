/**
 * Proxy transport and host-routing helpers for `dsh-proxy`.
 *
 * The plugin does not touch DeepSeek Harness source. It installs a wrapper
 * around `globalThis.fetch` — which both the DeepSeek adapter's raw `fetch` and
 * the pi-ai SDK clients call — and routes model-API hosts through a proxy
 * dispatcher, leaving every other host on this plugin's own **hardened direct**
 * channel. Only the hosts the configuration names are routed; `excludeHosts`
 * always stays direct, and loopback and private networks are exempt on top of
 * that (see {@link isExemptHostname}).
 *
 * Both channels are built from the same hardened options (see
 * `dsh-proxy/stability`): a long connect ceiling, TCP keepalive, a bounded
 * pooled-idle window, and a transport-level retry for connection failures. The
 * point of hardening the direct channel too is that "not proxied" must not mean
 * "back to undici's 10 second connect timeout" — the failing requests measured
 * on this machine were direct connects.
 * @module dsh-proxy/proxy
 */

import { Agent, Dispatcher, ProxyAgent, fetch as undiciFetch } from 'undici'
import { hostnameOf, isLanHostname, matchesHostEntry } from './hosts.js'
import { agentOptionsOf } from './stability.js'
import type { StabilityConfig } from './stability.js'
import { withTransportRetry } from './retry.js'
import type { RetryAttempt } from './retry.js'

export {
  DEFAULT_DEEPSEEK_HOST,
  DEFAULT_MODEL_HOST_SUFFIXES,
  DEFAULT_MODEL_HOSTS,
  hostnameOf,
  isLanHostname,
  matchesHostEntry,
  normalizeHostEntry,
} from './hosts.js'

/** Extract the absolute URL string from a `fetch` input. */
export function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/** One IPv4 octet, so a loopback match cannot accept `127.999.1.1`. */
const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'

/**
 * The whole `127.0.0.0/8` block, not just its first address: judging only
 * `127.0.0.1` misses `127.0.0.2`, which binds to loopback just as surely.
 */
const LOOPBACK_IPV4 = new RegExp('^127\\.' + IPV4_OCTET + '\\.' + IPV4_OCTET + '\\.' + IPV4_OCTET + '$')

/**
 * Whether a hostname names this machine, and therefore must stay direct.
 *
 * **This guarantee is this plugin's own; the routing this was built on had
 * none.** The baseline decides purely on `proxyHosts` / `excludeHosts`, which
 * is harmless while only a handful of model-API domains are routed, but the
 * harness's own Web UI, its Connection transport, and every local test server
 * listen on loopback, so a user who writes a loopback endpoint into
 * `proxyHosts` would send the harness's own traffic back through the proxy
 * and close a loop on it. Loopback is therefore exempt unconditionally.
 *
 * The test is deliberately **pure string comparison — never DNS**. A lookup
 * here would block, could disagree with what the socket actually resolves,
 * and would make a routing decision depend on the network being up.
 *
 * Callers pass `new URL(...).hostname`, which for IPv6 yields the bracketed
 * form, so `[::1]` and `[::ffff:127.0.0.1]` are handled alongside the bare
 * spellings; a trailing dot (the FQDN spelling `localhost.`) is stripped for
 * the same reason `normalizeHostEntry` strips it.
 * @param hostname - a URL hostname, bracketed or not, in any case.
 * @returns whether the host is loopback or an unspecified address.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true
  // The IPv4-mapped spelling: `::ffff:127.0.0.1` may arrive fully expanded
  // as `::ffff:7f00:1`, so read the high group and keep it when 127/8.
  const mappedHigh = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(host)?.[1]
  if (mappedHigh !== undefined) return Number.parseInt(mappedHigh, 16) >>> 8 === 127
  return LOOPBACK_IPV4.test(host.startsWith('::ffff:') ? host.slice(7) : host)
}

/**
 * Whether a hostname must never travel through a proxy at all.
 *
 * Two builds of the same rule, and both are this plugin's own guarantee rather
 * than a configurable one: loopback carries the harness's own surfaces (a
 * proxied Web UI request would loop back onto the proxy), and private networks
 * carry local model servers, MCP endpoints, and routers (a proxied LAN request
 * either fails or leaves the building). Listing such a host in
 * `proxyHosts` therefore cannot route it; `excludeHosts` is judged later
 * and only ever agrees.
 * @param hostname - a URL hostname, bracketed or not, in any case.
 * @returns whether the host is exempt from proxying.
 */
export function isExemptHostname(hostname: string): boolean {
  return isLoopbackHostname(hostname) || isLanHostname(hostname)
}

/**
 * Whether a URL's hostname is routed through the proxy.
 *
 * An entry is an umbrella — it covers its own domain and every host built on
 * it at any depth (see {@link matchesHostEntry}) — so a single `a.b` reaches
 * `a.b`, `*.a.b`, `*.*.a.b`, and the hyphen-joined region siblings. Malformed
 * URLs are never proxied.
 *
 * Exemptions are tested first and always stay direct, whatever the entries say:
 * loopback and private networks (see {@link isExemptHostname}). Loopback is
 * this plugin's own guarantee rather than a configurable one, so it outranks
 * `proxyHosts` and `excludeHosts` alike.
 *
 * Exclusions are judged against the same hostname, and they win: they are not
 * a subtraction from the entry set (which could only ever remove an entry
 * spelled identically) but a second umbrella test, so excluding `a.b` really
 * does keep all of it direct, and excluding `api.a.b` really does carve that
 * one child back out.
 * @param url - the absolute request URL.
 * @param hosts - normalized entries routed through the proxy.
 * @param exclude - normalized entries that must never be routed.
 * @returns whether the request should travel through the proxy.
 */
export function shouldProxy(
  url: string,
  hosts: ReadonlySet<string>,
  exclude?: ReadonlySet<string>,
): boolean {
  try {
    return shouldProxyHostname(new URL(url).hostname, hosts, exclude)
  } catch {
    return false
  }
}

/**
 * The same decision, taken from a hostname the caller already has.
 *
 * The dispatcher layer reasons about a request's origin and never builds a URL
 * for it, so this is the one place the rule lives and {@link shouldProxy} is
 * the URL-shaped entry to it.
 * @param hostname - the request hostname.
 * @param hosts - normalized entries routed through the proxy.
 * @param exclude - normalized entries that must never be routed.
 * @returns whether the request should travel through the proxy.
 */
export function shouldProxyHostname(
  hostname: string,
  hosts: ReadonlySet<string>,
  exclude?: ReadonlySet<string>,
): boolean {
  // Exemptions never travel, whatever the entries say.
  if (isExemptHostname(hostname)) return false
  // Exclusions are judged first because they are the highest-priority input:
  // an excluded host is direct without the routed list ever being consulted, so
  // naming it in both lists can only mean "direct".
  if (exclude !== undefined) {
    for (const entry of exclude) {
      if (matchesHostEntry(hostname, entry)) return false
    }
  }
  for (const entry of hosts) {
    if (matchesHostEntry(hostname, entry)) return true
  }
  return false
}

/** A proxy dispatcher plus a `fetch` bound to it, for teardown. */
export interface ProxyFetch {
  /** Fetch that routes every request through the proxy. */
  fetch: typeof fetch
  /** Close the proxy dispatcher's idle connections. */
  close(): Promise<void>
}

/** One hardened channel: its fetch, its dispatcher, and how to retire it. */
export interface HardenedChannel extends ProxyFetch {
  /** The dispatcher itself, so it can be re-exported to callers that need one. */
  dispatcher: Dispatcher
  /** Whether this channel actually travels through a proxy. */
  proxied: boolean
}

/** Build parameters shared by both channels. */
export interface ChannelOptions {
  /** Effective stability settings (timeouts, keepalive, retry budget). */
  stability: StabilityConfig
  /** Called once per transport retry, for the host half's log line. */
  onRetry?: (attempt: RetryAttempt) => void
}

/** Bind a fetch to one dispatcher, keeping the platform fetch's shape. */
function fetchWith(dispatcher: Dispatcher): typeof fetch {
  // undici's fetch and the platform fetch share a runtime shape but not a
  // nominal type; this cast is the whole boundary between the two views.
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(
      input as unknown as Parameters<typeof undiciFetch>[0],
      { ...init, dispatcher } as unknown as Parameters<typeof undiciFetch>[1],
    )) as unknown as typeof fetch
}

/**
 * Build one hardened channel.
 *
 * Without a proxy URL this is the direct channel — the one every unlisted host
 * uses, so it carries the same long connect ceiling, TCP keepalive, bounded
 * idle window, and transport retry as the proxied one. With a URL it is a
 * `ProxyAgent`, and its `connect.timeout` is what bounds the CONNECT tunnel
 * (the measured 10.5 s handshake that a 10 s default used to turn into
 * UND_ERR_CONNECT_TIMEOUT).
 * @param proxyUrl - the proxy endpoint, or undefined/empty for a direct channel.
 * @param options - stability settings and the retry reporter.
 * @returns the channel, ready to install.
 */
export function createHardenedChannel(proxyUrl: string | undefined, options: ChannelOptions): HardenedChannel {
  const agentOptions = agentOptionsOf(options.stability)
  const proxied = typeof proxyUrl === 'string' && proxyUrl.length > 0
  const dispatcher: Dispatcher = proxied
    ? new ProxyAgent({ uri: proxyUrl as string, ...agentOptions } as unknown as ConstructorParameters<typeof ProxyAgent>[0])
    : new Agent(agentOptions as unknown as ConstructorParameters<typeof Agent>[0])
  const retryPolicy = {
    maxRetries: options.stability.retryCount,
    baseDelayMs: options.stability.retryDelayMs,
    retryOnPossibleDelivery: options.stability.retryOnPossibleDelivery,
    ...(options.onRetry === undefined ? {} : { onRetry: options.onRetry }),
  }
  return {
    fetch: withTransportRetry(fetchWith(dispatcher), retryPolicy),
    dispatcher,
    proxied,
    close: () => dispatcher.close(),
  }
}

/**
 * Create a fetch bound to a proxy dispatcher, hardened by the shipped defaults.
 *
 * Kept as the narrow, single-purpose entry point; the host half builds its
 * channels through {@link createHardenedChannel} so it can pass live settings.
 * @param proxyUrl - the proxy endpoint.
 * @returns the proxy-bound fetch and its dispatcher closer.
 */
export function createProxyFetch(proxyUrl: string): ProxyFetch {
  const channel = createHardenedChannel(proxyUrl, {
    stability: {
      connectTimeoutMs: 60_000,
      responseTimeoutMs: 300_000,
      streamIdleTimeoutMs: 0,
      retryCount: 0,
      retryDelayMs: 400,
      retryOnPossibleDelivery: true,
    },
  })
  return { fetch: channel.fetch, close: channel.close }
}

/**
 * Wrap a channel so that requests to `hosts` travel through `proxyFetch` and
 * everything else keeps the caller's direct channel.
 *
 * The direct argument is deliberately the plugin's **hardened direct** fetch
 * rather than the platform fetch: a host that is not named in the configuration
 * still gets the longer connect ceiling, the keepalive, and the transport retry.
 * Falling back to the platform fetch would put every unlisted host back on
 * undici's 10 second connect timeout, which is the failure this plugin exists
 * to remove.
 *
 * `exclude` is the highest-priority input: an excluded host keeps the direct
 * fetch even when it also matches `hosts`, and an exempt host (loopback or a
 * private address) never travels at all (see {@link isExemptHostname}).
 * @param proxyFetch - the proxy-bound fetch.
 * @param directFetch - this plugin's hardened direct fetch.
 * @param hosts - umbrella entries routed through the proxy.
 * @param exclude - umbrella entries that must never be routed.
 * @returns the routing fetch.
 */
export function createRoutingFetch(
  proxyFetch: typeof fetch,
  directFetch: typeof fetch,
  hosts: ReadonlySet<string>,
  exclude?: ReadonlySet<string>,
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input as string | URL | Request)
    return shouldProxy(url, hosts, exclude) ? proxyFetch(input, init) : directFetch(input, init)
  }) as typeof fetch
}
