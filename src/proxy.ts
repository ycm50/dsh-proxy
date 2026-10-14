/**
 * Proxy transport and host-routing helpers for `dsh-proxy`.
 *
 * The plugin does not touch DeepSeek Harness source. It installs a wrapper
 * around `globalThis.fetch` — which both the DeepSeek adapter's raw `fetch` and
 * the pi-ai SDK clients call — and routes model-API hosts through a proxy
 * dispatcher, leaving every other host (web search, web fetch, MCP, …) on the
 * direct path, and only the hosts the configuration names are routed;
 * `excludeHosts` always stays direct. Loopback (`127.0.0.0/8`, `localhost`,
 * `::1`, and the IPv4-mapped spellings) always stays direct as well — see
 * {@link isLoopbackHostname}.
 * @module dsh-proxy/proxy
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { hostnameOf, matchesHostEntry } from './hosts.js'

export {
  DEFAULT_DEEPSEEK_HOST,
  DEFAULT_MODEL_HOST_SUFFIXES,
  DEFAULT_MODEL_HOSTS,
  hostnameOf,
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
 * Whether a URL's hostname is routed through the proxy.
 *
 * An entry is an umbrella — it covers its own domain and every host built on
 * it at any depth (see {@link matchesHostEntry}) — so a single `a.b` reaches
 * `a.b`, `*.a.b`, `*.*.a.b`, and the hyphen-joined region siblings. Malformed
 * URLs are never proxied.
 *
 * Loopback is tested first and always stays direct, whatever the entries say;
 * that bypass is this plugin's own guarantee rather than a configurable one,
 * so it outranks `proxyHosts` and `excludeHosts` alike. See
 * {@link isLoopbackHostname}.
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
    const hostname = new URL(url).hostname
    // Loopback never travels, whatever the entries say.
    if (isLoopbackHostname(hostname)) return false
    // Exclusions are judged first because they are the highest-priority
    // input: an excluded host is direct without the routed list ever being
    // consulted, so naming it in both lists can only mean "direct".
    if (exclude !== undefined) {
      for (const entry of exclude) {
        if (matchesHostEntry(hostname, entry)) return false
      }
    }
    for (const entry of hosts) {
      if (matchesHostEntry(hostname, entry)) return true
    }
    return false
  } catch {
    return false
  }
}

/** A proxy dispatcher plus a `fetch` bound to it, for teardown. */
export interface ProxyFetch {
  /** Fetch that routes every request through the proxy. */
  fetch: typeof fetch
  /** Close the proxy dispatcher's idle connections. */
  close(): Promise<void>
}

/**
 * Create a fetch bound to a proxy dispatcher. `undici`'s `ProxyAgent` accepts
 * `http:`, `https:`, `socks4:`, `socks4a:`, `socks5:`, and `socks5h:` proxy URLs.
 * @param proxyUrl - the proxy endpoint.
 * @returns the proxy-bound fetch and its dispatcher closer.
 */
export function createProxyFetch(proxyUrl: string): ProxyFetch {
  const dispatcher = new ProxyAgent(proxyUrl)
  // undici's `fetch` and its `Request`/`RequestInit` types are nominally
  // distinct from the platform fetch types, but share the same runtime shape;
  // these casts are the whole boundary between the two views.
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(
      input as unknown as Parameters<typeof undiciFetch>[0],
      { ...init, dispatcher } as unknown as Parameters<typeof undiciFetch>[1],
    )) as unknown as typeof fetch
  return {
    fetch: fetchImpl,
    close: () => dispatcher.close(),
  }
}

/**
 * Wrap a platform fetch so that requests to `hosts` travel through
 * `proxyFetch` and everything else keeps the original fetch.
 *
 * `exclude` is the highest-priority input: an excluded host keeps the
 * original fetch even when it also matches `hosts`, and loopback never
 * travels at all (see {@link isLoopbackHostname}).
 * @param proxyFetch - the proxy-bound fetch.
 * @param original - the fetch to keep for non-proxied hosts.
 * @param hosts - umbrella entries routed through the proxy.
 * @param exclude - umbrella entries that must never be routed.
 * @returns the routing fetch.
 */
export function createRoutingFetch(
  proxyFetch: typeof fetch,
  original: typeof fetch,
  hosts: ReadonlySet<string>,
  exclude?: ReadonlySet<string>,
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input as string | URL | Request)
    return shouldProxy(url, hosts, exclude) ? proxyFetch(input, init) : original(input, init)
  }) as typeof fetch
}
