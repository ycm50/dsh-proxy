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
 * The pooled-idle window this plugin allows, in milliseconds.
 *
 * Deliberately far below undici's 600 s default: a socket that has sat idle for
 * minutes is exactly the one a carrier NAT, a proxy, or the peer itself has
 * already dropped, and reusing it is how "Connection error." and "terminated"
 * appear on a request that a fresh connection would have served. 60 s of idle
 * costs one extra handshake after a long pause and removes that class.
 */
export declare const POOLED_IDLE_WINDOW_MS = 60000;
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
/** One short line for the mount log, so the effective budget is never a guess. */
export declare function describeStability(stability: StabilityConfig): string;
//# sourceMappingURL=stability.d.ts.map