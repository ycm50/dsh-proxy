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
/** One attempt that is about to be retried; the caller logs it. */
export interface RetryAttempt {
    /** 1 for the first retry. */
    attempt: number;
    /** The configured ceiling, for context in a log line. */
    maxRetries: number;
    /** The transport code that triggered the retry. */
    code: string;
    /** The request URL, so a log line names the host. */
    url: string;
}
/** Retry policy as the request path applies it. */
export interface RetryPolicy {
    /** Extra attempts after the first; 0 disables this layer entirely. */
    maxRetries: number;
    /** First backoff, doubled per attempt and jittered by up to a quarter. */
    baseDelayMs: number;
    /** Whether a possibly-delivered failure qualifies (see the module note). */
    retryOnPossibleDelivery?: boolean;
    /** Called once per retry, before the backoff sleep. */
    onRetry?: (attempt: RetryAttempt) => void;
}
/** The transport code carried by a fetch failure, if any. */
export declare function transportCodeOf(error: unknown): string;
/**
 * Whether a failure is a connection-level failure this layer may retry.
 * @param error - the rejection from a fetch call.
 * @param retryOnPossibleDelivery - whether possibly-delivered failures qualify.
 * @returns whether to try again.
 */
export declare function isRetryableTransportError(error: unknown, retryOnPossibleDelivery?: boolean): boolean;
/**
 * Whether a request body can be sent a second time.
 *
 * Everything undici accepts as a replayable body is listed explicitly; a
 * `ReadableStream`, an async iterable, or anything unrecognised is not, so
 * `duplex: 'half'` and stream bodies are one-shot by construction.
 * @param init - the fetch init that accompanied the request.
 * @returns whether a retry may resend the same body.
 */
export declare function isReplayableRequest(init: RequestInit | undefined): boolean;
/**
 * Whether a signal has already fired.
 *
 * A function rather than an inline comparison on purpose: the value changes
 * across an `await`, which control-flow analysis cannot see, so a direct
 * comparison after an earlier check would be narrowed away by the compiler.
 * @param signal - the request's abort signal, if any.
 * @returns whether the caller already cancelled.
 */
export declare function isAborted(signal: AbortSignal | null | undefined): boolean;
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
export declare function withTransportRetry(fetchImpl: typeof fetch, policy: RetryPolicy): typeof fetch;
//# sourceMappingURL=retry.d.ts.map