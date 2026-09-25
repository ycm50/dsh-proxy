/**
 * Proxy transport and host-routing helpers for `dsh-http-proxy`.
 *
 * The plugin does not touch DeepSeek Harness source. It installs a wrapper
 * around `globalThis.fetch` — which both the DeepSeek adapter's raw `fetch` and
 * the pi-ai SDK clients call — and routes only model-API hosts through a
 * proxy dispatcher, leaving every other host (web search, web fetch, MCP, …)
 * on the direct path.
 * @module dsh-http-proxy/proxy
 */
export { DEFAULT_DEEPSEEK_HOST, DEFAULT_MODEL_HOST_SUFFIXES, DEFAULT_MODEL_HOSTS, hostnameOf, matchesHostEntry, normalizeHostEntry, } from './hosts.js';
/** Extract the absolute URL string from a `fetch` input. */
export declare function urlOf(input: string | URL | Request): string;
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
export declare function shouldProxy(url: string, hosts: ReadonlySet<string>, exclude?: ReadonlySet<string>): boolean;
/** A proxy dispatcher plus a `fetch` bound to it, for teardown. */
export interface ProxyFetch {
    /** Fetch that routes every request through the proxy. */
    fetch: typeof fetch;
    /** Close the proxy dispatcher's idle connections. */
    close(): Promise<void>;
}
/**
 * Create a fetch bound to a proxy dispatcher. `undici`'s `ProxyAgent` accepts
 * `http:`, `https:`, `socks4:`, `socks4a:`, `socks5:`, and `socks5h:` proxy URLs.
 * @param proxyUrl - the proxy endpoint.
 * @returns the proxy-bound fetch and its dispatcher closer.
 */
export declare function createProxyFetch(proxyUrl: string): ProxyFetch;
/**
 * Wrap a platform fetch so that requests to `hosts` travel through
 * `proxyFetch` and everything else keeps the original fetch.
 * @param proxyFetch - the proxy-bound fetch.
 * @param original - the fetch to keep for non-proxied hosts.
 * @param hosts - umbrella entries routed through the proxy.
 * @param exclude - umbrella entries that must never be routed.
 * @returns the routing fetch.
 */
export declare function createRoutingFetch(proxyFetch: typeof fetch, original: typeof fetch, hosts: ReadonlySet<string>, exclude?: ReadonlySet<string>): typeof fetch;
//# sourceMappingURL=proxy.d.ts.map