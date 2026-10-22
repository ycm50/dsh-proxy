// Offline test for the transport-retry layer: which failures qualify, which
// requests may be replayed, how a caller's abort interacts with the backoff,
// and that a zero budget is a true no-op. No network: every attempt is a fake
// fetch that fails on demand.
import {
  isReplayableRequest,
  isRetryableTransportError,
  transportCodeOf,
  withTransportRetry,
} from '../lib/index.js'

let failures = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failures++
  console.log((ok ? 'ok  ' : 'FAIL ') + label + (ok ? '' : ' -- got ' + a + ', want ' + e))
}

/** A fetch rejection shaped the way undici shapes one. */
const failure = (code) => {
  const error = new Error('fetch failed')
  error.cause = { code }
  return error
}

// --- 1. Which failures qualify ----------------------------------------------
check('a refused connection is retryable', isRetryableTransportError(failure('ECONNREFUSED')), true)
check('a connect timeout is retryable', isRetryableTransportError(failure('UND_ERR_CONNECT_TIMEOUT')), true)
check('a transient DNS failure is retryable', isRetryableTransportError(failure('EAI_AGAIN')), true)
check('a reset is retryable by default', isRetryableTransportError(failure('ECONNRESET')), true)
check('a reset is not retryable when the caller opts out', isRetryableTransportError(failure('ECONNRESET'), false), false)
check('an abort is never retryable', isRetryableTransportError(failure('UND_ERR_ABORTED')), false)
check('an HTTP-status class error is not a transport failure', isRetryableTransportError(new Error('500 status code')), false)
check('a bare error carries no code', transportCodeOf(new Error('x')), '')
check('a direct code is read too', transportCodeOf({ code: 'EPIPE' }), 'EPIPE')

// --- 2. Which bodies may be replayed ----------------------------------------
check('no body is replayable', isReplayableRequest(undefined), true)
check('a string body is replayable', isReplayableRequest({ body: 'x' }), true)
check('bytes are replayable', isReplayableRequest({ body: new Uint8Array(2) }), true)
check('url-encoded params are replayable', isReplayableRequest({ body: new URLSearchParams({ a: '1' }) }), true)
check('a half-duplex stream is not', isReplayableRequest({ body: 'x', duplex: 'half' }), false)
check('an unknown body is not', isReplayableRequest({ body: { pipe() {} } }), false)

// --- 3. Retrying ------------------------------------------------------------
let calls = 0
const flaky = withTransportRetry(async () => {
  calls += 1
  if (calls < 3) throw failure('ECONNRESET')
  return { status: 200 }
}, { maxRetries: 3, baseDelayMs: 1 })
const response = await flaky('https://a.example/v1')
check('two failures then a success resolves', response.status, 200)
check('the attempt count is three', calls, 3)

let seen = []
calls = 0
const reported = withTransportRetry(async () => {
  calls += 1
  if (calls === 1) throw failure('ECONNREFUSED')
  return { status: 200 }
}, {
  maxRetries: 2,
  baseDelayMs: 1,
  onRetry: (attempt) => seen.push([attempt.attempt, attempt.maxRetries, attempt.code, attempt.url]),
})
await reported('https://b.example/v1')
check('the retry is reported with its code and url', seen, [[1, 2, 'ECONNREFUSED', 'https://b.example/v1']])

calls = 0
const doomed = withTransportRetry(async () => {
  calls += 1
  throw failure('ECONNREFUSED')
}, { maxRetries: 2, baseDelayMs: 1 })
let surfaced
try { await doomed('https://c.example/v1') } catch (error) { surfaced = transportCodeOf(error) }
check('an exhausted budget rethrows the transport code', surfaced, 'ECONNREFUSED')
check('an exhausted budget stops after maxRetries+1 attempts', calls, 3)

calls = 0
const safeOnly = withTransportRetry(async () => {
  calls += 1
  throw failure('ECONNRESET')
}, { maxRetries: 3, baseDelayMs: 1, retryOnPossibleDelivery: false })
try { await safeOnly('https://d.example/v1') } catch { /* the point is the attempt count */ }
check('safe-only mode sends a possibly-delivered reset once', calls, 1)

calls = 0
const streamed = withTransportRetry(async () => {
  calls += 1
  throw failure('ECONNREFUSED')
}, { maxRetries: 3, baseDelayMs: 1 })
try { await streamed('https://e.example/v1', { body: 'payload', duplex: 'half' }) } catch { /* counted below */ }
check('a non-replayable body is sent once', calls, 1)

// --- 4. How a caller's abort interacts --------------------------------------
const controller = new AbortController()
calls = 0
const aborting = withTransportRetry(async () => {
  calls += 1
  throw failure('ECONNREFUSED')
}, { maxRetries: 5, baseDelayMs: 2000 })
const started = Date.now()
const pending = aborting('https://f.example/v1', { signal: controller.signal }).then(
  () => ({ code: 'resolved' }),
  (error) => ({ code: transportCodeOf(error) }),
)
setTimeout(() => controller.abort(), 20)
const aborted = await pending
const elapsed = Date.now() - started
check('an abort surfaces the original failure', aborted.code, 'ECONNREFUSED')
check('an abort cuts the backoff short', elapsed < 900, true)

calls = 0
const preAborted = new AbortController()
preAborted.abort()
const immediate = withTransportRetry(async () => {
  calls += 1
  throw failure('ECONNREFUSED')
}, { maxRetries: 5, baseDelayMs: 1 })
try { await immediate('https://g.example/v1', { signal: preAborted.signal }) } catch { /* counted below */ }
check('an already-aborted caller is attempted once', calls, 1)

// --- 5. A zero budget is identity -------------------------------------------
const impl = async () => ({ status: 200 })
check('maxRetries 0 returns the very same function', withTransportRetry(impl, { maxRetries: 0, baseDelayMs: 1 }) === impl, true)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
