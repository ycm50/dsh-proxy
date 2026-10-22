/**
 * Per-request timing for the two channels: the numbers that turn "the first
 * token got slower" into a decision.
 *
 * Why this exists: every fix for first-token latency is a bet about where the
 * time goes — a handshake inside a proxy tunnel, a dial that a warm pool would
 * have skipped, or the gateway itself thinking. Without a record of *which*
 * connection carried each request and how long it took to answer, those bets
 * are guesses. The measurements that motivated this module (a local proxy
 * adding 1.3-1.6 s of tunnel cost per fresh connection, and a direct path whose
 * time-to-first-byte swung between 0.7 s and 6.2 s on the same host) were only
 * visible with exactly these three numbers.
 *
 * Design rules, all of them about not disturbing what is measured:
 *   - **Off by default.** The host half constructs an observer only when the
 *     environment asks for one, so the shipped request path keeps no timer, no
 *     ring buffer, and no diagnostics subscription.
 *   - **The response is never rebuilt.** The first-chunk time is read from
 *     `response.clone()`, which leaves the object the caller receives — its
 *     status, headers, `url`, and body identity — untouched. A reconstructed
 *     `Response` would silently drop `url` and `redirected`.
 *   - **The clone is cancelled after one chunk**, so a streaming body is not
 *     buffered a second time for the rest of its life.
 *   - **Connection freshness comes from undici itself**, via the
 *     `undici:client:beforeConnect` diagnostics channel, rather than from a
 *     guess about pool internals.
 * @module dsh-proxy/observe
 */
/** Which channel carried one request. */
export type ObservedChannel = 'proxy' | 'direct';
/** What one request looked like from inside the plugin. */
export interface RequestSample {
    /** Wall-clock start, for lining samples up with a log. */
    at: number;
    /** The channel the routing layer chose. */
    channel: ObservedChannel;
    /** Uppercase request method, when the input carried one. */
    method: string;
    /** `scheme://host[:port]`, with no path, so tokens never reach the log. */
    origin: string;
    /** Response status, or 0 when the request failed before headers. */
    status: number;
    /** Dispatch to response headers: dial + handshake + upload + first response. */
    headersMs: number;
    /** Headers to the first `text/event-stream` chunk — the first token. */
    firstChunkMs: number | null;
    /** Whether this request had to dial a new connection (no warm socket). */
    freshConnection: boolean;
}
/** Aggregate shape for one channel. */
export interface ObserverStats {
    /** Requests measured on this channel. */
    requests: number;
    /** How many of them had to open a new connection. */
    fresh: number;
    /** Median time to response headers, in milliseconds. */
    headersP50: number;
    /** 95th percentile time to response headers, in milliseconds. */
    headersP95: number;
    /** Median time to the first streamed chunk, or null when none was measured. */
    firstP50: number | null;
    /** 95th percentile time to the first streamed chunk, or null. */
    firstP95: number | null;
}
/** Everything the summary of one observer holds. */
export interface ObserverSummary {
    /** Samples currently retained (the ring is bounded). */
    samples: number;
    proxy: ObserverStats;
    direct: ObserverStats;
}
/** Construction options for {@link ProxyObserver}. */
export interface ObserverOptions {
    /** One line per finished request, plus a periodic summary. */
    log?(line: string): void;
    /** How many samples the ring keeps (default 50). */
    capacity?: number;
    /** Emit a summary line after this many samples (default 20, 0 disables). */
    summaryEvery?: number;
    /** Injectable clock, so tests do not depend on wall time. */
    now?(): number;
}
/** A fetch-shaped function; the observer wraps one of these per channel. */
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
/**
 * Records what each channel's requests cost, and reports it.
 *
 * One observer belongs to one plugin instance: it subscribes to the process-wide
 * diagnostics channel while it lives and must be disposed with the fiber.
 */
export declare class ProxyObserver {
    #private;
    constructor(options?: ObserverOptions);
    /**
     * Wrap one channel's fetch so every attempt is measured.
     *
     * Wrapping happens *inside* the transport-retry layer, so one sample is one
     * attempt: a retried connection shows up as two samples instead of one
     * misleadingly slow one.
     * @param channel - which channel this fetch belongs to.
     * @param fetchImpl - the channel's own fetch.
     * @returns the timing wrapper, shaped exactly like the fetch it wraps.
     */
    wrapFetch(channel: ObservedChannel, fetchImpl: FetchLike): FetchLike;
    /** The newest samples, oldest first. */
    recent(limit?: number): RequestSample[];
    /** Aggregate the retained samples per channel. */
    summary(): ObserverSummary;
    /** Forget every sample and dial count, keeping the subscription. */
    reset(): void;
    /** Stop listening to the diagnostics channel; a disposed observer records nothing. */
    dispose(): void;
}
/**
 * Build an observer from an environment value, so the host half can decide with
 * one call whether instrumentation is on.
 *
 * Off is the default and stays the default: the request path ships without a
 * timer, a ring buffer, or a diagnostics subscription.
 * @param raw - the environment value (`DSH_PROXY_DEBUG`).
 * @param options - log sink and sizing, as {@link ObserverOptions}.
 * @returns the observer, or undefined when the value does not ask for one.
 */
export declare function observerFromEnv(raw: string | undefined, options?: ObserverOptions): ProxyObserver | undefined;
export {};
//# sourceMappingURL=observe.d.ts.map