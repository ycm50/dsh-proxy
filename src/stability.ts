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
  connectTimeoutMs: number
  /** Ceiling for waiting on response headers; 0 disables the watchdog. */
  responseTimeoutMs: number
  /** Ceiling for the gap between body chunks; 0 disables it (slow streams survive). */
  streamIdleTimeoutMs: number
  /** Transport-level retries for connection failures (0 turns them off). */
  retryCount: number
  /** First backoff delay; doubling per attempt with jitter. */
  retryDelayMs: number
  /** Whether a reset after the request may already have been delivered is retried too. */
  retryOnPossibleDelivery: boolean
}

/** One stability field name. */
export type StabilityField = keyof StabilityConfig

/** Field names, in the order the settings page shows them. */
export const STABILITY_FIELDS: readonly (keyof StabilityConfig)[] = [
  'connectTimeoutMs',
  'responseTimeoutMs',
  'streamIdleTimeoutMs',
  'retryCount',
  'retryDelayMs',
  'retryOnPossibleDelivery',
]

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
export const DEFAULT_STABILITY: StabilityConfig = {
  connectTimeoutMs: 60_000,
  responseTimeoutMs: 300_000,
  streamIdleTimeoutMs: 0,
  retryCount: 3,
  retryDelayMs: 400,
  retryOnPossibleDelivery: true,
}

/** Inclusive bounds per numeric field; a value outside is clamped, never rejected. */
export const STABILITY_BOUNDS: Readonly<Record<Exclude<keyof StabilityConfig, 'retryOnPossibleDelivery'>, { min: number; max: number }>> = {
  connectTimeoutMs: { min: 1_000, max: 600_000 },
  responseTimeoutMs: { min: 0, max: 3_600_000 },
  streamIdleTimeoutMs: { min: 0, max: 3_600_000 },
  retryCount: { min: 0, max: 10 },
  retryDelayMs: { min: 50, max: 10_000 },
}

/** One warn sink; the caller passes its logger in. */
export type StabilityWarn = (message: string) => void

/**
 * Read one numeric field out of raw configuration: a finite integer in range
 * is taken as-is (clamped when it falls outside), anything else falls back to
 * the default. Both repairs are reported, because a silently ignored setting
 * is worse than a loud one.
 * @param field - the field being read.
 * @param raw - the stored value, of unknown shape.
 * @param warn - where a repair is reported.
 * @returns the effective value.
 */
function stabilizeNumber(field: keyof typeof STABILITY_BOUNDS, raw: unknown, warn?: StabilityWarn): number {
  const fallback = DEFAULT_STABILITY[field]
  const bounds = STABILITY_BOUNDS[field]
  if (raw === undefined || raw === null) return fallback
  const numeric = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(numeric)) {
    warn?.('dsh-proxy: ' + field + ' is not a number; using ' + String(fallback))
    return fallback
  }
  const rounded = Math.round(numeric)
  if (rounded < bounds.min || rounded > bounds.max) {
    const clamped = Math.min(bounds.max, Math.max(bounds.min, rounded))
    warn?.('dsh-proxy: ' + field + ' ' + String(rounded) + 'ms is outside ' + String(bounds.min) + '-' + String(bounds.max) + '; using ' + String(clamped))
    return clamped
  }
  return rounded
}

/**
 * Turn one raw configuration object into effective stability settings.
 * @param raw - stored values; absent fields take their defaults.
 * @param warn - where a repaired value is reported.
 * @returns the effective settings.
 */
export function readStability(raw: Partial<Record<keyof StabilityConfig, unknown>> | undefined, warn?: StabilityWarn): StabilityConfig {
  const source = raw ?? {}
  return {
    connectTimeoutMs: stabilizeNumber('connectTimeoutMs', source.connectTimeoutMs, warn),
    responseTimeoutMs: stabilizeNumber('responseTimeoutMs', source.responseTimeoutMs, warn),
    streamIdleTimeoutMs: stabilizeNumber('streamIdleTimeoutMs', source.streamIdleTimeoutMs, warn),
    retryCount: stabilizeNumber('retryCount', source.retryCount, warn),
    retryDelayMs: stabilizeNumber('retryDelayMs', source.retryDelayMs, warn),
    retryOnPossibleDelivery: source.retryOnPossibleDelivery === undefined
      ? DEFAULT_STABILITY.retryOnPossibleDelivery
      : source.retryOnPossibleDelivery === true,
  }
}

/** Whether the settings carry anything away from the shipped defaults. */
export function stabilityIsDefault(stability: StabilityConfig): boolean {
  for (const field of STABILITY_FIELDS) {
    if (stability[field] !== DEFAULT_STABILITY[field]) return false
  }
  return true
}

/** The socket-level shape undici's `connect` option takes. */
export interface HardenedConnectOptions {
  timeout: number
  keepAlive: boolean
  keepAliveInitialDelay: number
  autoSelectFamily: boolean
  autoSelectFamilyAttemptTimeout: number
}

/** The agent options both channels are built from, kept structurally typed for tests. */
export interface HardenedAgentOptions {
  connectTimeout: number
  headersTimeout: number
  bodyTimeout: number
  keepAliveTimeout: number
  keepAliveMaxTimeout: number
  keepAliveTimeoutThreshold: number
  pipelining: number
  maxRedirections: number
  connect: HardenedConnectOptions
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
export const POOLED_IDLE_WINDOW_MS = 60_000

/** How long an accepted socket may sit before its first keepalive probe. */
export const TCP_KEEPALIVE_DELAY_MS = 30_000

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
export function agentOptionsOf(stability: StabilityConfig): HardenedAgentOptions {
  return {
    connectTimeout: stability.connectTimeoutMs,
    headersTimeout: stability.responseTimeoutMs,
    bodyTimeout: stability.streamIdleTimeoutMs,
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: POOLED_IDLE_WINDOW_MS,
    keepAliveTimeoutThreshold: 1_000,
    pipelining: 1,
    maxRedirections: 0,
    connect: {
      timeout: stability.connectTimeoutMs,
      keepAlive: true,
      keepAliveInitialDelay: TCP_KEEPALIVE_DELAY_MS,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 2_500,
    },
  }
}

/** One short line for the mount log, so the effective budget is never a guess. */
export function describeStability(stability: StabilityConfig): string {
  const seconds = (ms: number) => (ms === 0 ? 'off' : String(Math.round(ms / 1000)) + 's')
  return 'connect=' + seconds(stability.connectTimeoutMs)
    + ' headers=' + seconds(stability.responseTimeoutMs)
    + ' body=' + seconds(stability.streamIdleTimeoutMs)
    + ' retry=' + String(stability.retryCount) + 'x' + String(stability.retryDelayMs) + 'ms'
    + (stability.retryOnPossibleDelivery ? '' : ' retry-safe-only')
}
