/**
 * Stability knobs: the plain shape the settings page edits, the defaults this
 * plugin ships, range clamping, and the translation into `undici` options.
 *
 * Why this module exists at all: undici's own defaults are tuned for a healthy
 * datacentre link — a 10 second connect timeout, a 600 second pooled-idle reuse
 * window, and no TCP keepalive. A very slow model gateway, a lossy link, or a
 * forward proxy that takes its time establishing an upstream turns those
 * defaults into hard failures, which the harness then reports as a connection
 * error and retries as a whole request (hitting the same bad path again).
 * Measured on this machine: a proxied CONNECT that took 10.5 s, and a direct
 * connect that consumed 10.373 s of wall clock with 0.0 ms of CPU before
 * failing with UND_ERR_CONNECT_TIMEOUT.
 *
 * Every field is meant to be edited live, so this module never throws on a bad
 * value: it clamps into range and reports through the supplied warn callback,
 * because a typo in a settings box must not take the request path down.
 * @module dsh-proxy/stability
 */
/** The stability fields as stored and edited. */
export interface StabilityConfig {
    /** TCP connect / proxy CONNECT ceiling, in milliseconds. */
    connectTimeoutMs: number;
    /** Ceiling for waiting on response headers; 0 disables the watchdog. */
    responseTimeoutMs: number;
    /** Ceiling for the gap between body chunks; 0 disables it (slow streams survive). */
    streamIdleTimeoutMs: number;
    /**
     * How long an **unproven direct** channel gets to answer, in milliseconds.
     *
     * This is a routing deadline, not a transport ceiling: it is measured to the
     * response headers, and it only applies while a host's channel is still being
     * decided. A budget that runs out no longer throws the host's working direct
     * path away — see `dsh-proxy/routing` — but it does still cost the time it
     * ran, so the shipped value is a whole answer's worth, not a single second:
     * the direct path measured on this machine answered in 2.9-6.9 s on the same
     * host that failed at one second, and every one of those one-second probes
     * was a wasted second plus a pointless proxy detour.
     */
    probeTimeoutMs: number;
    /**
     * How long an **unproven proxy tunnel** gets to answer, in milliseconds.
     *
     * Deliberately shorter than {@link probeTimeoutMs}, and still far above what a
     * `CONNECT` costs: the local proxy answers the tunnel itself in 1-14 ms, while
     * the TLS handshake inside it plus the first response headers measured 1.4-2.2 s
     * on this machine. The one second this budget used to be cut *every* one of
     * those answers off, which is why a working tunnel was recorded as 27 failures
     * and zero successes in a single log.
     */
    proxyProbeTimeoutMs: number;
    /** Transport-level retries for connection failures (0 turns them off). */
    retryCount: number;
    /** First backoff delay; doubling per attempt with jitter. */
    retryDelayMs: number;
    /** Whether a reset after the request may already have been delivered is retried too. */
    retryOnPossibleDelivery: boolean;
}
/** One stability field name. */
export type StabilityField = keyof StabilityConfig;
/** Field names, in the order the settings page shows them. */
export declare const STABILITY_FIELDS: readonly (keyof StabilityConfig)[];
/**
 * Defaults.
 *
 * `connectTimeoutMs` is the one that matters most for a slow gateway: 60 s
 * clears the measured 10.5 s proxy CONNECT with room for a bad minute, where
 * undici's 10 s turned the same request into UND_ERR_CONNECT_TIMEOUT.
 * `responseTimeoutMs` keeps undici's own 5 minutes. `streamIdleTimeoutMs`
 * is off, so a model that thinks for a while before its next chunk is never
 * cut off here — the harness has its own stream watchdog for that.
 */
export declare const DEFAULT_STABILITY: StabilityConfig;
/** Inclusive bounds per numeric field; a value outside is clamped, never rejected. */
export declare const STABILITY_BOUNDS: Readonly<Record<Exclude<keyof StabilityConfig, 'retryOnPossibleDelivery'>, {
    min: number;
    max: number;
}>>;
/** One warn sink; the caller passes its logger in. */
export type StabilityWarn = (message: string) => void;
/**
 * Turn one raw configuration object into effective stability settings.
 * @param raw - stored values; absent fields take their defaults.
 * @param warn - where a repaired value is reported.
 * @returns the effective settings.
 */
export declare function readStability(raw: Partial<Record<keyof StabilityConfig, unknown>> | undefined, warn?: StabilityWarn): StabilityConfig;
/** Whether the settings carry anything away from the shipped defaults. */
export declare function stabilityIsDefault(stability: StabilityConfig): boolean;
/** The socket-level shape undici's `connect` option takes. */
export interface HardenedConnectOptions {
    timeout: number;
    keepAlive: boolean;
    keepAliveInitialDelay: number;
    autoSelectFamily: boolean;
    autoSelectFamilyAttemptTimeout: number;
}
/** The agent options both channels are built from, kept structurally typed for tests. */
export interface HardenedAgentOptions {
    connectTimeout: number;
    headersTimeout: number;
    bodyTimeout: number;
    keepAliveTimeout: number;
    keepAliveMaxTimeout: number;
    keepAliveTimeoutThreshold: number;
    pipelining: number;
    maxRedirections: number;
    connect: HardenedConnectOptions;
}
/**
 * How long a pooled connection may sit idle before undici retires it.
 *
 * Measured on this machine (a local HTTP proxy in front of a model gateway):
 * a fresh tunnel costs 1.3-1.6 s, almost all of it a second TLS handshake
 * inside the proxy `CONNECT`, and a conversation's cadence is one user turn
 * every 10-60 s. undici's own default is 4 s and this plugin used to ship
 * 60 s, so in practice **every message paid for a new tunnel** — which is
 * exactly the first-token latency this constant now removes: 120 s keeps a
 * conversation on one tunnel, so the handshake no longer sits inside the
 * first token.
 *
 * The trade-off is a socket that has sat idle long enough for a carrier NAT,
 * the proxy, or the peer to have dropped it. That is not left to luck: undici
 * discards a pooled socket it sees close while idle, and the transport retry
 * layer in `dsh-proxy/retry` re-dials anything that slips through.
 */
export declare const POOLED_IDLE_WINDOW_MS = 120000;
/**
 * The ceiling the negotiated keep-alive timeout may grow to.
 *
 * undici only raises the effective window when a response carries
 * `Keep-Alive: timeout=N`, and caps that at this value. It has to stay at or
 * above {@link POOLED_IDLE_WINDOW_MS}, or a server's own answer would pull the
 * window back down below the one this plugin chose.
 */
export declare const POOLED_IDLE_MAX_MS = 300000;
/**
 * How long one address family gets before the next is dialled alongside it.
 *
 * **This is not a latency knob, it is a deadline on a working dial**, and 250 ms
 * is below this machine's own handshake time. Measured here, a direct TCP
 * handshake to a Cloudflare-fronted host costs 228 ms at the median and 500-1 300
 * ms at the tail. With a 250 ms window the happy-eyeballs timer aborts a dial
 * that was going to succeed, moves to the next address, aborts that one too, and
 * then hits the IPv6 entries — which on this network are `ENETUNREACH` in 0-4 ms —
 * so every address is spent and the whole call fails with `ETIMEDOUT` at about
 * 2 x the window. Interleaved A/B on this machine, 100 cold dials per arm:
 *
 * | window | failures |
 * | --- | --- |
 * | 250 ms | **10/100** (`ETIMEDOUT` at 500-510 ms) |
 * | 2 500 ms | 0/100 |
 * | autoSelectFamily off | 0/100 |
 *
 * 2 500 ms was this plugin's original value and it was never the problem: the
 * comment that replaced it with 250 ms reasoned about a *black-holed IPv6* (where
 * a long window costs the wait), but this network *refuses* IPv6 instantly, so
 * the long window costs nothing and the short one breaks healthy dials. Keep it
 * well above a real handshake; `connectTimeoutMs` is what bounds a dial that
 * genuinely hangs.
 */
export declare const HAPPY_EYEBALLS_ATTEMPT_MS = 2500;
/** How long an accepted socket may sit before its first keepalive probe. */
export declare const TCP_KEEPALIVE_DELAY_MS = 30000;
/**
 * Translate stability settings into agent options.
 *
 * Two settings carry most of the weight. `connectTimeout` (and the matching
 * `connect.timeout`, which is what a proxy CONNECT is bounded by) is the
 * ceiling that stops a slow handshake from being read as an unreachable host.
 * `connect.keepAlive` with a 30 s first probe makes a black-holed
 * connection fail at the TCP level in about a minute instead of letting a
 * request wait out the SDK's ten-minute deadline.
 * @param stability - the effective settings.
 * @returns options for an undici Agent or ProxyAgent.
 */
export declare function agentOptionsOf(stability: StabilityConfig): HardenedAgentOptions;
/**
 * The connector options every socket this plugin opens is built from.
 *
 * One function for three call sites, because `undici`'s `ProxyAgent` does not
 * read the top-level `connect` object at all: it builds its two connectors from
 * `proxyTls` (the dial to the proxy) and `requestTls` (the TLS handshake to the
 * target inside the tunnel), each through `buildConnector({ ...thatOption })`.
 * Until this was spelled out separately, {@link StabilityConfig.connectTimeoutMs}
 * reached the direct channel only and the tunnel kept undici's 10 s default —
 * the very ceiling that turned a measured 10.5 s handshake into
 * `UND_ERR_CONNECT_TIMEOUT`. `proxy.ts` therefore passes this same object as
 * both `proxyTls` and `requestTls`, so the ceiling applies where a CONNECT
 * tunnel is actually established.
 * @param stability - the effective settings.
 * @returns connector options for an undici Agent or ProxyAgent.
 */
export declare function connectorOptionsOf(stability: StabilityConfig): HardenedConnectOptions;
/** One short line for the mount log, so the effective budget is never a guess. */
export declare function describeStability(stability: StabilityConfig): string;
//# sourceMappingURL=stability.d.ts.map