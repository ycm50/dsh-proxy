/**
 * Transport-level retry: the innermost of the three retry layers a model
 * request passes through.
 *
 * The harness retries whole requests (dsh-llm-retry) and the SDK layer is
 * configured not to retry at all, so a connection failure that is pure bad luck
 * — a SYN that a flaky route dropped, a pooled socket the peer had already
 * closed — used to consume one whole harness attempt. This layer re-dials
 * immediately, before the failure is ever visible upstairs, which is what turns
 * "four retries all failed" into "one request succeeded".
 *
 * Safety rules, in order of importance:
 *   - A request whose body cannot be replayed is sent exactly once. A stream or
 *     an async iterable cannot be re-read, so retrying it would send a truncated
 *     body.
 *   - A caller's abort is never retried, and the backoff sleep is interruptible,
 *     so pressing Stop is immediate.
 *   - Only connection-level failures qualify. An HTTP status is a response, not
 *     a transport failure, and belongs to the harness's own policy.
 *   - A reset that may have arrived after the request was delivered is retried
 *     only when the configuration says so (retryOnPossibleDelivery), because
 *     for a non-idempotent request that costs a duplicate.
 * @module dsh-proxy/retry
 */

/** Failures that prove nothing was delivered: retrying cannot duplicate work. */
const NOT_DELIVERED = new Set([
  'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'EAI_AGAIN',
  // A name that does not resolve is the classic "the direct path is blocked"
  // failure, and the failure a proxy fixes: it must qualify for the failover to
  // the proxy channel.
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'EHOSTDOWN',
])

/** Failures where the request may already have reached the peer. */
const POSSIBLY_DELIVERED = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
])

/** One attempt that is about to be retried; the caller logs it. */
export interface RetryAttempt {
  /** 1 for the first retry. */
  attempt: number
  /** The configured ceiling, for context in a log line. */
  maxRetries: number
  /** The transport code that triggered the retry. */
  code: string
  /** The request URL, so a log line names the host. */
  url: string
}

/** Retry policy as the request path applies it. */
export interface RetryPolicy {
  /** Extra attempts after the first; 0 disables this layer entirely. */
  maxRetries: number
  /** First backoff, doubled per attempt and jittered by up to a quarter. */
  baseDelayMs: number
  /** Whether a possibly-delivered failure qualifies (see the module note). */
  retryOnPossibleDelivery?: boolean
  /** Called once per retry, before the backoff sleep. */
  onRetry?: (attempt: RetryAttempt) => void
}

/** The transport code carried by a fetch failure, if any. */
export function transportCodeOf(error: unknown): string {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null | undefined
  const fromCause = candidate?.cause?.code
  if (typeof fromCause === 'string') return fromCause
  const direct = candidate?.code
  if (typeof direct === 'string') return direct
  return ''
}

/**
 * Whether a failure is a connection-level failure this layer may retry.
 * @param error - the rejection from a fetch call.
 * @param retryOnPossibleDelivery - whether possibly-delivered failures qualify.
 * @returns whether to try again.
 */
export function isRetryableTransportError(error: unknown, retryOnPossibleDelivery = true): boolean {
  const code = transportCodeOf(error)
  if (code.length === 0) return false
  if (NOT_DELIVERED.has(code)) return true
  return retryOnPossibleDelivery && POSSIBLY_DELIVERED.has(code)
}

/** A URL string for a log line, without importing the routing module back. */
function urlOfInput(input: unknown): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  const request = input as { url?: unknown } | null | undefined
  return typeof request?.url === 'string' ? request.url : ''
}

/**
 * Whether a request body can be sent a second time.
 *
 * Everything undici accepts as a replayable body is listed explicitly; a
 * `ReadableStream`, an async iterable, or anything unrecognised is not, so
 * `duplex: 'half'` and stream bodies are one-shot by construction.
 * @param init - the fetch init that accompanied the request.
 * @returns whether a retry may resend the same body.
 */
export function isReplayableRequest(init: RequestInit | undefined): boolean {
  if (init === undefined) return true
  if ((init as { duplex?: unknown }).duplex === 'half') return false
  const body = (init as { body?: unknown }).body
  if (body === undefined || body === null) return true
  if (typeof body === 'string') return true
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return true
  if (ArrayBuffer.isView(body)) return true
  if (body instanceof ArrayBuffer) return true
  if (typeof Blob !== 'undefined' && body instanceof Blob) return true
  if (typeof FormData !== 'undefined' && body instanceof FormData) return true
  return false
}

/**
 * Whether a signal has already fired.
 *
 * A function rather than an inline comparison on purpose: the value changes
 * across an `await`, which control-flow analysis cannot see, so a direct
 * comparison after an earlier check would be narrowed away by the compiler.
 * @param signal - the request's abort signal, if any.
 * @returns whether the caller already cancelled.
 */
export function isAborted(signal: AbortSignal | null | undefined): boolean {
  return signal !== null && signal !== undefined && signal.aborted === true
}

/**
 * Sleep that a caller's abort can cut short, so Stop stays immediate.
 *
 * Exported because the routing layer runs the retry loop itself (it has to: each
 * attempt takes a different channel), and that loop needs the same interruptible
 * wait the single-channel retry uses.
 * @param ms - how long to wait.
 * @param signal - the caller's abort signal, if any.
 * @returns a promise that settles when the wait ends or the caller aborts.
 */
export function abortableSleep(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted === true || ms <= 0) {
      resolve()
      return
    }
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/**
 * The backoff before one retry: the base doubled per attempt, jittered by up to
 * a quarter either way so a fleet of clients does not retry in lockstep.
 * @param baseDelayMs - the configured first delay.
 * @param attempt - 1 for the first retry.
 * @returns the delay in whole milliseconds.
 */
export function retryDelayMs(baseDelayMs: number, attempt: number): number {
  const base = Number.isFinite(baseDelayMs) ? Math.max(0, baseDelayMs) : 0
  return Math.round(base * 2 ** (Math.max(1, attempt) - 1) * (0.75 + Math.random() * 0.5))
}

/**
 * Wrap a fetch so connection-level failures are re-dialled.
 *
 * The returned fetch resolves or rejects exactly like the one it wraps: once
 * the attempts are exhausted the original error is rethrown unchanged, so the
 * harness sees the transport code it always saw.
 * @param fetchImpl - the channel fetch (direct or proxied) to wrap.
 * @param policy - retry budget and reporting.
 * @returns the retrying fetch, or `fetchImpl` unchanged when retries are off.
 */
export function withTransportRetry(fetchImpl: typeof fetch, policy: RetryPolicy): typeof fetch {
  const maxRetries = Number.isFinite(policy.maxRetries) ? Math.max(0, Math.trunc(policy.maxRetries)) : 0
  if (maxRetries === 0) return fetchImpl
  const baseDelayMs = Number.isFinite(policy.baseDelayMs) ? Math.max(0, policy.baseDelayMs) : 0
  const retryOnPossibleDelivery = policy.retryOnPossibleDelivery !== false

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal ?? null
    const replayable = isReplayableRequest(init)
    let attempt = 0
    for (;;) {
      try {
        return await fetchImpl(input, init)
      } catch (error) {
        const code = transportCodeOf(error)
        const worthRetrying = attempt < maxRetries
          && replayable
          && !isAborted(signal)
          && isRetryableTransportError(error, retryOnPossibleDelivery)
        if (!worthRetrying) throw error
        attempt += 1
        policy.onRetry?.({ attempt, maxRetries, code, url: urlOfInput(input) })
        await abortableSleep(retryDelayMs(baseDelayMs, attempt), signal)
        // The caller may have aborted during the sleep: surface the abort, not a stale retry.
        if (isAborted(signal)) throw error
      }
    }
  }) as typeof fetch
}
