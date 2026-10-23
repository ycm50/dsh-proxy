/**
 * Proxy transport and host-routing helpers for `dsh-proxy`.
 *
 * The plugin does not touch DeepSeek Harness source. It installs a wrapper
 * around `globalThis.fetch` — which both the DeepSeek adapter's raw `fetch` and
 * the pi-ai SDK clients call — and decides, per host, whether a request takes the
 * proxy or this plugin's own **hardened direct** channel. Hosts on the force list
 * always take the proxy; every other host starts direct and only moves onto the
 * proxy when direct does not answer in time or fails outright (see
 * {@link RouteMemory}). Loopback and private networks are exempt throughout (see
 * {@link isExemptHostname}).
 *
 * Both channels are built from the same hardened options (see
 * `dsh-proxy/stability`): a long connect ceiling, TCP keepalive, a bounded
 * pooled-idle window, and a transport-level retry for connection failures. The
 * point of hardening the direct channel too is that "not proxied" must not mean
 * "back to undici's 10 second connect timeout" — the failing requests measured
 * on this machine were direct connects.
 * @module dsh-proxy/proxy
 */
import { Dispatcher } from 'undici';
import type { StabilityConfig } from './stability.js';
import type { RetryAttempt } from './retry.js';
import type { ProxyObserver } from './observe.js';
import type { RouteAttempt, RouteMemory } from './routing.js';
export { DEFAULT_DEEPSEEK_HOST, DEFAULT_MODEL_HOST_SUFFIXES, DEFAULT_MODEL_HOSTS, hostnameOf, isLanHostname, matchesHostEntry, normalizeHostEntry, } from './hosts.js';
/** Extract the absolute URL string from a `fetch` input. */
export declare function urlOf(input: string | URL | Request): string;
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
export declare function isLoopbackHostname(hostname: string): boolean;
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
export declare function isExemptHostname(hostname: string): boolean;
/**
 * Whether a hostname is pinned to the proxy by the force list.
 *
 * The force list is the one list there is: a host named there always travels
 * through the proxy, and it is the answer for a site that *can* be reached
 * directly but is throttled hard enough that trying is pointless — a mirror that
 * answers in 30 s direct and in 2 s through the proxy. A pinned host never
 * probes and never moves (see `dsh-proxy/routing`): there is no direct attempt to
 * compare against.
 *
 * The built-in exemption still outranks it: loopback and private networks never
 * travel at all, whatever the list says.
 * @param hostname - the request hostname.
 * @param force - normalized entries pinned to the proxy.
 * @returns whether the request must travel through the proxy.
 */
export declare function shouldForceProxy(hostname: string, force: ReadonlySet<string>): boolean;
/** A proxy dispatcher plus a `fetch` bound to it, for teardown. */
export interface ProxyFetch {
    fetch: typeof fetch;
    /** Close the proxy dispatcher's idle connections. */
    close(): Promise<void>;
}
/** One hardened channel: its fetch, its dispatcher, and how to retire it. */
export interface HardenedChannel extends ProxyFetch {
    /** The dispatcher itself, so it can be re-exported to callers that need one. */
    dispatcher: Dispatcher;
    /** Whether this channel actually travels through a proxy. */
    proxied: boolean;
    /**
     * The same channel without its transport retry.
     *
     * The routing layer needs a failure to arrive at its own decision point
     * immediately: in auto mode the retry that matters is "try the other
     * channel", and four internal re-dials of a path that just failed only delay
     * it. Unlisted hosts keep using {@link ProxyFetch.fetch}, so the transport
     * retry is still there wherever it is the only retry available.
     */
    fetchOnce: typeof fetch;
}
/** Build parameters shared by both channels. */
export interface ChannelOptions {
    /** Effective stability settings (timeouts, keepalive, retry budget). */
    stability: StabilityConfig;
    /** Called once per transport retry, for the host half's log line. */
    onRetry?: (attempt: RetryAttempt) => void;
    /** Opt-in request timing; absent means the channel measures nothing. */
    observer?: ProxyObserver;
}
/** Header pairs, from anything fetch accepts as a header list. */
export declare function headerPairs(headers: unknown): Array<[string, string]> | undefined;
/** One fetch call, in the shape this plugin's own undici can read. */
export interface NormalisedCall {
    /** The URL string, or an input the bundled undici already recognises. */
    input: string | URL | Request;
    /** The init to pass beside it. */
    init: RequestInit | undefined;
}
/**
 * Turn a `(input, init)` pair into one the bundled undici understands.
 *
 * This plugin bundles its own `undici`, so its `Request` class is a **different
 * class** from the one the platform `fetch` hands out. A `Request` built by the
 * platform is therefore not `instanceof` the bundled `Request`, and passing it
 * straight through made undici stringify it to `"[object Request]"` and reject
 * with `ERR_INVALID_URL` — instantly, before any socket, on every attempt and on
 * both channels. That is exactly the "four retries, none of them connected"
 * shape, and it is why a settings edit (which changes the request shape) could
 * make it disappear.
 *
 * So a foreign request is taken apart instead of forwarded: its URL, method,
 * headers, body and the rest are copied into a plain init the bundled undici can
 * read. The body is copied as bytes, never as decoded text. A `Request` this
 * plugin built itself is passed through untouched.
 * @param input - the fetch input.
 * @param init - the fetch init, if any.
 * @returns the input and init to call the bundled fetch with.
 */
export declare function normaliseFetchCall(input: string | URL | Request, init?: RequestInit): Promise<NormalisedCall>;
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
export declare function createHardenedChannel(proxyUrl: string | undefined, options: ChannelOptions): HardenedChannel;
/**
 * Create a fetch bound to a proxy dispatcher, hardened by the shipped defaults.
 *
 * Kept as the narrow, single-purpose entry point; the host half builds its
 * channels through {@link createHardenedChannel} so it can pass live settings.
 * @param proxyUrl - the proxy endpoint.
 * @returns the proxy-bound fetch and its dispatcher closer.
 */
export declare function createProxyFetch(proxyUrl: string): ProxyFetch;
/** The two fetch shapes the routing layer chooses between. */
export interface RoutingChannels {
    /** The hardened proxy channel. */
    proxy: typeof fetch;
    /** The hardened direct channel. */
    direct: typeof fetch;
}
/** Construction options for {@link createRoutingFetch}. */
export interface RoutingOptions {
    /** Extra attempts after the first; 0 sends every request exactly once. */
    retryCount: number;
    /** First backoff before a retry, doubled per attempt and jittered. */
    baseDelayMs: number;
    /** Whether a failure that may already have been delivered is retried too. */
    retryOnPossibleDelivery: boolean;
    /**
     * How long an unproven channel gets to answer, in milliseconds.
     *
     * Absent takes {@link PROBE_TIMEOUT_MS}. The budget applies only while a host's
     * channel is still being decided (see `dsh-proxy/routing`); a host that has
     * already been settled is never cut off by it.
     */
    probeTimeoutMs?: number;
    /**
     * Whether the configuration pins this hostname to the proxy.
     *
     * A pinned host has no direct path and therefore nothing to probe; the built-in
     * loopback/LAN exemption is applied here too, so a pinned name can never be
     * made to leave the machine.
     */
    forcedProxy?(hostname: string): boolean;
    /** Called once per finished attempt: the record the user asked for. */
    onAttempt?(attempt: RouteAttempt): void;
    /** Called once per retry, before its backoff. */
    onRetry?(attempt: RetryAttempt): void;
}
/**
 * Wrap the two channels so each host is decided once and then kept on the
 * channel that answered.
 *
 * The direct argument is deliberately the plugin's **hardened direct** fetch
 * rather than the platform fetch: a host the configuration does not name still
 * gets the longer connect ceiling, the keepalive, and the transport retry.
 * Falling back to the platform fetch would put it back on undici's 10 second
 * connect timeout, which is the failure this plugin exists to remove.
 *
 * The strategy is {@link RouteMemory}'s, and it is what the user asked for: a
 * host that is on no list starts direct with a {@link PROBE_TIMEOUT_MS} budget;
 * answering settles it on direct for the session, and only a direct path that
 * stays silent hands it to the proxy (same budget). The channel that answers is
 * kept, so a healthy host never alternates, while a settled channel that then
 * fails outright still gets one probe of the other. A pinned host skips all of
 * it and stays on the proxy.
 *
 * Retrying is gated by whether the request can be sent again: the body must be
 * replayable and the caller must not have aborted. A failure that may already
 * have been delivered is resent only when `retryOnPossibleDelivery` is on — and
 * a failure carrying **no** transport code counts as possibly delivered, because
 * that is the case where refusing to move would strand the host on a channel
 * that does not work. What a failure never does is leave the host's decision
 * where it was: the memory advances even when the request itself must stop.
 * The probe sequence is the routing decision and is bounded by the memory to
 * three attempts. Once there is nothing left to try the original error is
 * rethrown unchanged, so the harness sees the transport code it always saw.
 * @param channels - the proxy fetch and the direct fetch.
 * @param memory - the per-host channel memory.
 * @param options - retry budget, probe deadline, pinning, and where attempts are recorded.
 * @returns the routing fetch.
 */
export declare function createRoutingFetch(channels: RoutingChannels, memory: RouteMemory, options: RoutingOptions): typeof fetch;
//# sourceMappingURL=proxy.d.ts.map