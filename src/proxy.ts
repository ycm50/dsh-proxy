/**
 * Proxy transport and host-routing helpers for `dsh-proxy`.
 *
 * The plugin does not touch DeepSeek Harness source. It installs a wrapper
 * around `globalThis.fetch` — which both the DeepSeek adapter's raw `fetch` and
 * the pi-ai SDK clients call — and routes only model-API hosts through a
 * proxy dispatcher, leaving every other host (web search, web fetch, MCP, …)
 * on the direct path.
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

/**
 * Whether a URL's hostname is routed through the proxy.
 *
 * An entry is an umbrella — it covers its own domain and every host built on
 * it at any depth (see {@link matchesHostEntry}) — so a single `a.b` reaches
 * `a.b`, `*.a.b`, `*.*.a.b`, and the hyphen-joined region siblings. Malformed
 * URLs are never proxied.
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
    let covered = false
    for (const entry of hosts) {
      if (matchesHostEntry(hostname, entry)) {
        covered = true
        break
      }
    }
    if (!covered) return false
    if (exclude !== undefined) {
      for (const entry of exclude) {
        if (matchesHostEntry(hostname, entry)) return false
      }
    }
    return true
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
