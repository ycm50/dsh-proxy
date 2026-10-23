/**
 * Phase timing for a request that never produced response headers.
 *
 * Why this exists: the attempt record says *that* a probe timed out and how long
 * it waited, but not **where** the time went — a CONNECT the proxy never
 * answered, a TLS handshake inside the tunnel, or response headers that never
 * arrived. That distinction is the whole diagnosis: on this machine the tunnel
 * opened in 1-14 ms while the same attempt still missed a one-second budget, so
 * the ceiling was cutting off a working tunnel instead of detecting a dead one,
 * and nothing in the log could say so.
 *
 * The numbers come from undici's own diagnostics channels rather than from a
 * wrapper, because a wrapper measures the caller's wait and not the phases it
 * consists of:
 *   - 'undici:client:connected' for the target host is the moment the socket (or
 *     the CONNECT tunnel) is up: `connectMs`.
 *   - 'undici:request:headers' for the same **request object** is the moment the
 *     response arrived: `headersMs`. A probe times out when this never fires.
 *     The request object is what `undici:request:create` hands out, and binding
 *     to it is not decoration: origin alone is shared by every concurrent request
 *     to that host, and a tracker that took another request's headers reported a
 *     probe as answered in 1 274 ms while the attempt itself timed out at
 *     3 005 ms. One object, one answer.
 *   - 'undici:client:connectError' carries the transport code when the dial
 *     itself failed, which separates "could not reach" from "did not answer".
 *
 * Off unless something asks for a tracker, so the request path pays nothing when
 * no probe is running. One tracker is one attempt; `finish` reads it and any
 * later event is ignored.
 * @module dsh-proxy/timeline
 */
/** One attempt's phase breakdown, in milliseconds from the attempt's start. */
export interface ProbeTimeline {
    /** Milliseconds until the socket to the target (or the CONNECT tunnel) was up. */
    connectMs?: number;
    /** Milliseconds until response headers arrived; absent when they never did. */
    headersMs?: number;
    /** Transport code of a connect failure, when the dial itself failed. */
    connectError?: string;
}
/** One open measurement. */
export interface ProbeTracker {
    /**
     * Read what happened so far.
     * @returns the phases that were observed.
     */
    finish(): ProbeTimeline;
    /** Stop observing this attempt. Safe to call more than once. */
    dispose(): void;
}
/**
 * Start measuring one attempt.
 *
 * `origin` is the absolute request origin ('scheme://host'); `hostname` is the
 * host whose socket marks the connection as up — for a proxied attempt that is
 * still the target host, because the tunnel's own dial to the proxy is reported
 * as a separate connection with the proxy's own hostname.
 * @param origin - the request's origin, in the form undici reports it.
 * @param hostname - the target hostname.
 * @returns the tracker; `dispose` it when the attempt ends.
 */
export declare function openProbeTracker(origin: string, hostname: string): ProbeTracker;
/** Render one timeline for a log line; empty string when nothing was observed. */
export declare function describeTimeline(timeline: ProbeTimeline): string;
//# sourceMappingURL=timeline.d.ts.map