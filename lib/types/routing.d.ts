/**
 * The channel rotation: a host that is on no list retries on the *other*
 * channel — direct, proxy, direct, proxy — and every attempt is recorded.
 *
 * Why this replaced the measured choice: the previous strategy kept per-host
 * statistics (a slow-direct budget, a cooldown ladder, strikes in both
 * directions) so a listed host would settle on whichever channel looked better.
 * That is a lot of machinery for a question the user can answer by watching:
 * which of the two paths actually works right now. The shipped rule is now the
 * blunt one — every host that is not pinned to the proxy and is not a loopback
 * or LAN name alternates channels on its retries, so one broken path can never
 * consume a whole turn while the other one is healthy.
 *
 * The rules, deliberately simple:
 *   - The **first** attempt of a host goes direct.
 *   - **Every** attempt then moves the host to the other channel — success or
 *     failure, answered or refused. The rotation is a round-robin, not a
 *     verdict: the next attempt takes the path the last one did not, so a run of
 *     retries reads direct, proxy, direct, proxy and the two channels are
 *     exercised in turn instead of one of them being trusted on the strength of
 *     a single good minute.
 *   - A host pinned by the force list never alternates (it is always proxied),
 *     and a loopback or LAN name never leaves the machine: those two answers
 *     outrank the rotation entirely.
 *   - Every attempt is handed to the caller, which records it (see
 *     `dsh-proxy/index`'s attempt log line): channel, attempt number, outcome,
 *     transport code, and how long it took. That record is what makes "which
 *     path is broken" a fact rather than a guess.
 *
 * This module is pure state: it never touches the network, so the rotation
 * below is asserted offline.
 * @module dsh-proxy/routing
 */
/** The two channels a request can travel on. */
export type RouteChannel = 'proxy' | 'direct';
/** The channel an untouched host starts on. */
export declare const FIRST_CHANNEL: RouteChannel;
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
}
/**
 * Which channel each host's next attempt takes.
 *
 * One instance belongs to one generation of channels, so a settings change that
 * rebuilds the channels rebuilds this too and every host starts from direct
 * again — the honest answer to "the transport was just reconfigured".
 */
export declare class ChannelRotation {
    #private;
    /**
     * The channel the next attempt for this host should take.
     *
     * Pure: the dispatcher asks for every request and the wrapper asks again for
     * the same one, so asking must not move the cursor.
     * @param hostname - the request's hostname.
     * @returns the channel for the next attempt.
     */
    channelFor(hostname: string): RouteChannel;
    /**
     * Record one finished attempt and move the cursor.
     *
     * Unconditional on purpose: the outcome is already in the record the caller
     * keeps, and the rotation does not need it. Every attempt — success or
     * failure — hands the next one to the other channel, which is what makes the
     * sequence read direct, proxy, direct, proxy rather than settling on whichever
     * channel happened to answer last.
     * @param hostname - the request's hostname.
     * @returns the channel the next attempt will take.
     */
    record(hostname: string): RouteChannel;
    /**
     * What the rotation holds for one host, for tests and log lines.
     * @param hostname - the request's hostname.
     * @returns the channel the next attempt would take, or undefined when the
     * host has never failed (and therefore never moved).
     */
    stateOf(hostname: string): RouteChannel | undefined;
    /** Forget every host, so every one of them starts direct again. */
    reset(): void;
}
/** One line describing the shipped strategy, for the mount log. */
export declare function describeRotation(maxAttempts: number): string;
//# sourceMappingURL=routing.d.ts.map