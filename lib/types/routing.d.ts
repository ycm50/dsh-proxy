/**
 * The per-host channel memory: a host is decided **once** and then kept on that
 * channel for the rest of the session.
 *
 * The previous strategy rotated on every attempt — direct, proxy, direct,
 * proxy — which kept both paths exercised but also kept *all* of a host's
 * traffic on the wrong one half of the time, and put a fresh 1.3–1.9 s tunnel
 * inside half of the first tokens. This module replaces the rotation with a
 * decision that is remembered, which is what the user asked for: the first
 * request of a session goes direct, and only a direct path that does not answer
 * moves the host onto the proxy — and once a channel answers, the host stays
 * there.
 *
 * The rules, in the order they are applied:
 *   - A host pinned by the force list always travels through the proxy; it never
 *     probes and never moves. A loopback or LAN name never leaves the machine.
 *     Both answers outrank the memory entirely.
 *   - Every other host starts **direct**, with a {@link PROBE_TIMEOUT_MS}
 *     budget. Answering inside it settles the host on direct for the session.
 *   - A direct attempt that does not answer in time hands the host to the proxy,
 *     which gets the same budget. Answering settles the host on the proxy (the
 *     "direct is unreachable, so keep using the tunnel" case).
 *   - A proxy attempt that also runs out of time falls back to direct for one
 *     **unbounded** attempt: with both probes inconclusive the direct path is
 *     still the default, and cutting it off a second time would leave the user
 *     with an error they could have avoided.
 *   - A settled host that then fails outright (a connection error, not a slow
 *     answer) probes the other channel once and settles on it when it answers;
 *     when that probe fails too, the host goes back to direct. Success never
 *     moves a host: there is no timed rotation.
 *   - **Any** failure moves the decision (unless the caller cancelled or the
 *     body cannot be re-sent). Advancing the decision sends nothing, and
 *     freezing it is what once pinned a host to the channel that had just
 *     failed: the next request then opened with the same doomed probe and failed
 *     the same way, which is the "consecutive failures" the log showed.
 *
 * This module is pure state: it never touches the network or a clock of its own
 * (the probe deadline lives in the request path), so every transition is
 * asserted offline.
 * @module dsh-proxy/routing
 */
/** The two channels a request can travel on. */
export type RouteChannel = 'proxy' | 'direct';
/** The channel an untouched host starts on; also the fallback of last resort. */
export declare const FIRST_CHANNEL: RouteChannel;
/**
 * How long an unproven channel gets to answer before the other one is tried.
 *
 * The user's rule is 1 second, measured to the response headers: a direct path
 * that cannot produce a first byte inside it is treated as not working, and the
 * proxy gets the same chance. This is a routing deadline, not the transport
 * ceiling in `dsh-proxy/stability`: a host that is already settled is never cut
 * off by it.
 */
export declare const PROBE_TIMEOUT_MS = 1000;
/** The transport code a probe that ran out of time carries, for the log. */
export declare const PROBE_TIMEOUT_CODE = "PROBE_TIMEOUT";
/** The other channel, for a host that just failed. */
export declare function otherChannel(channel: RouteChannel): RouteChannel;
/** One finished dispatch, as the process-wide dispatcher reports it. */
export interface DispatchRecord {
    /** The request's hostname. */
    hostname: string;
    /** The channel the dispatch took. */
    channel: RouteChannel;
    /** Whether the request produced response headers. */
    ok: boolean;
    /** Dispatch to headers (or to the failure), in milliseconds. */
    ms: number;
    /** Transport code of the failure, when the dispatch carried one. */
    code?: string;
}
/** One finished attempt, as the request path reports it. */
export interface RouteAttempt {
    /** The request's hostname; `''` when the URL could not be read. */
    hostname: string;
    /** 1 for the first attempt of this request. */
    attempt: number;
    /** How many attempts this request is allowed in total. */
    maxAttempts: number;
    /** The channel this attempt actually used. */
    channel: RouteChannel;
    /** Whether the attempt produced a response (of any status). */
    ok: boolean;
    /** Wall time of the attempt: to the response headers, or to the failure. */
    ms: number;
    /** Transport code of the failure, when the attempt carried one. */
    code?: string;
    /** The failure's message, the only clue when no transport code exists. */
    message?: string;
    /** Whether this attempt was still proving its channel (the probe budget applied). */
    probe?: boolean;
    /** The channel the next attempt will take; absent when the request is over. */
    next?: RouteChannel;
}
/**
 * What the next attempt for a host takes.
 *
 * `probe` marks a channel that has not answered yet: the request path bounds it
 * with {@link PROBE_TIMEOUT_MS}. `fallback` marks the final direct attempt after
 * both probes ran out of time: it is not bounded and it is never moved to the
 * proxy again (a failure there ends the request).
 */
export interface RouteDecision {
    /** The channel the attempt must take. */
    channel: RouteChannel;
    /** Whether the channel still has to prove itself; the probe budget applies. */
    probe: boolean;
    /** Whether this is the unbounded direct attempt after both probes failed. */
    fallback: boolean;
}
/** What the memory holds for one host, for tests and log lines. */
export type RouteState = RouteDecision;
/**
 * Which channel each host is on, remembered for the session.
 *
 * One instance belongs to one generation of channels, so a settings change that
 * rebuilds the channels (or a new session, see `dsh-proxy/index`) starts every
 * host from direct again — the honest answer to "the transport was just
 * reconfigured" and to "this is a new conversation".
 */
export declare class RouteMemory {
    #private;
    /**
     * The channel the next attempt for this host should take.
     *
     * Pure: the dispatcher asks for every request and the wrapper asks again for
     * the same one, so asking must not advance the state.
     * @param hostname - the request's hostname.
     * @returns the decision for the next attempt.
     */
    decide(hostname: string): RouteDecision;
    /**
     * Record that a channel answered, and keep the host on it.
     *
     * Every success lands here, including the first direct probe, the proxy probe
     * that replaced a silent direct path, and the other channel that rescued a
     * settled host. A host that already settled on this channel is left alone.
     * @param hostname - the request's hostname.
     * @param channel - the channel that answered.
     */
    settle(hostname: string, channel: RouteChannel): void;
    /**
     * Record one failed attempt and decide what the next one may take.
     *
     * A failure on the channel currently being probed advances that probe to its
     * successor; a failure on a settled channel starts a one-shot probe of the
     * other channel; a failure of the fallback forgets the host, so the next
     * request starts the decision over. An outcome that no longer matches the
     * state (another request moved the host in between) follows the current
     * decision instead of counting the failure twice.
     * @param hostname - the request's hostname.
     * @param channel - the channel that failed.
     * @returns the decision for the next attempt, or undefined when this request
     * has no further attempt to make.
     */
    failed(hostname: string, channel: RouteChannel): RouteDecision | undefined;
    /**
     * What the memory holds for one host, for tests and log lines.
     * @param hostname - the request's hostname.
     * @returns the decision, or undefined when the host has never been touched.
     */
    stateOf(hostname: string): RouteState | undefined;
    /** Forget every host, so every one of them starts direct again. */
    reset(): void;
}
/** One line describing the shipped strategy, for the mount log. */
export declare function describeRouting(maxAttempts: number, probeTimeoutMs?: number): string;
//# sourceMappingURL=routing.d.ts.map