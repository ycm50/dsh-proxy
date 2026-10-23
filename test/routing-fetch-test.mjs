// Offline test for the routing fetch: which channel each *attempt* takes, when
// a host's choice is settled, and the exact conditions under which an attempt is
// repeated or handed to the other channel.
//
// No network: both channels are fakes that record their calls, and the probe
// budget is shortened to 40 ms so a "silent" channel is one that never answers.
// The strategy under test is the shipped one — attempt 1 goes direct and a host
// that answers stays there; only silence or a failure moves it, once.
import {
  RouteMemory,
  createRoutingFetch,
} from '../lib/index.js'

let failures = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failures++
  console.log((ok ? 'ok  ' : 'FAIL ') + label + (ok ? '' : ' -- got ' + a + ', want ' + e))
}

const UNPINNED = 'https://api.opencode.ai/v1/chat/completions'
const UNPINNED_HOST = 'api.opencode.ai'
const PINNED = 'https://mirror.example/v1/chat'
const LOOPBACK = 'http://127.0.0.1:9/v1/chat'
const PROBE_MS = 40

/** A transport failure as undici reports it: the code rides on `cause`. */
const failure = (code) => Object.assign(new Error(code), { cause: Object.assign(new Error(code), { code }) })

const ok = (status = 200) => new Response('{}', { status, headers: { 'content-type': 'application/json' } })

/** A channel that accepts the request and never answers it. */
const silent = () => new Promise(() => {})

/**
 * Two fake channels, a real memory, and the records the wrapper produces.
 *
 * `calls` is the channel of every attempt in order, so an assertion reads as the
 * sequence the user would see in the log. Each channel fake receives the
 * zero-based index of its own call, so a test can make only the first attempt
 * silent.
 */
function harness(options = {}) {
  const calls = []
  const bodies = { proxy: [], direct: [] }
  let proxyIndex = 0
  let directIndex = 0
  const channels = {
    proxy: async (_input, init) => {
      calls.push('proxy')
      bodies.proxy.push(init?.body)
      return (options.proxy ?? (() => ok()))(proxyIndex++)
    },
    direct: async (_input, init) => {
      calls.push('direct')
      bodies.direct.push(init?.body)
      return (options.direct ?? (() => ok()))(directIndex++)
    },
  }
  const memory = new RouteMemory()
  const attempts = []
  const retries = []
  const fetchImpl = createRoutingFetch(channels, memory, {
    retryCount: options.retryCount ?? 3,
    baseDelayMs: options.baseDelayMs ?? 0,
    retryOnPossibleDelivery: options.retryOnPossibleDelivery !== false,
    probeTimeoutMs: options.probeTimeoutMs ?? PROBE_MS,
    forcedProxy: options.forcedProxy,
    onAttempt: (attempt) => { attempts.push(attempt) },
    onRetry: (retry) => { retries.push(retry) },
  })
  return { calls, bodies, memory, attempts, retries, fetchImpl }
}

const state = (memory, host) => memory.stateOf(host) ?? '(none)'
const DIRECT_KEPT = { channel: 'direct', probe: false, fallback: false }
const PROXY_KEPT = { channel: 'proxy', probe: false, fallback: false }
const PROBE_PROXY = { channel: 'proxy', probe: true, fallback: false }

// --- 1. A healthy host goes direct, and stays there ------------------------
// The regression this file exists for: this used to read direct, proxy, direct,
// proxy — one request per channel, forever.
{
  const { calls, memory, attempts, retries, fetchImpl } = harness()
  const response = await fetchImpl(UNPINNED)
  check('a healthy request goes direct', calls, ['direct'])
  check('it answers the caller', response.status, 200)
  check('no retry happened', retries.length, 0)
  check('one attempt was recorded', attempts.length, 1)
  check('the record names the channel', attempts[0].channel, 'direct')
  check('the record marks the probe', attempts[0].probe, true)
  check('the record says the channel is kept', attempts[0].next, 'direct')
  check('the answer settles the host on direct', state(memory, UNPINNED_HOST), DIRECT_KEPT)
  await fetchImpl(UNPINNED)
  check('the next request keeps using direct', calls, ['direct', 'direct'])
}

// --- 2. Silent direct hands the host to the proxy, and the proxy is kept ----
{
  const { calls, memory, fetchImpl } = harness({ direct: (n) => (n === 0 ? silent() : ok()) })
  const response = await fetchImpl(UNPINNED)
  check('a silent direct path moves to the proxy', calls, ['direct', 'proxy'])
  check('the caller is answered', response.status, 200)
  check('the proxy answer is kept', state(memory, UNPINNED_HOST), PROXY_KEPT)
  calls.length = 0
  await fetchImpl(UNPINNED)
  check('the next request goes straight to the proxy', calls, ['proxy'])
}

// --- 3. Both silent: direct gets one unbounded fallback attempt -------------
{
  const { calls, memory, fetchImpl } = harness({ direct: (n) => (n === 0 ? silent() : ok()), proxy: () => silent() })
  const response = await fetchImpl(UNPINNED)
  check('both probes fail and direct gets the last attempt', calls, ['direct', 'proxy', 'direct'])
  check('the fallback answers the caller', response.status, 200)
  check('the fallback settles the host on direct', state(memory, UNPINNED_HOST), DIRECT_KEPT)
}

// --- 4. A settled channel that fails gets one probe of the other -----------
{
  let directMode = 'ok'
  const { calls, memory, fetchImpl } = harness({
    direct: () => {
      if (directMode === 'fail') throw failure('ECONNREFUSED')
      return ok()
    },
  })
  await fetchImpl(UNPINNED)
  directMode = 'fail'
  calls.length = 0
  const response = await fetchImpl(UNPINNED)
  check('a failed settled channel probes the other one', calls, ['direct', 'proxy'])
  check('the rescuing channel is answered', response.status, 200)
  check('and it is kept', state(memory, UNPINNED_HOST), PROXY_KEPT)
}

// --- 5. Both channels failing ends the request and forgets the host --------
{
  const { calls, memory, attempts, fetchImpl } = harness({
    direct: () => { throw failure('ECONNREFUSED') },
    proxy: () => { throw failure('ECONNRESET') },
  })
  let surfaced
  try {
    await fetchImpl(UNPINNED)
  } catch (error) {
    surfaced = error.cause?.code
  }
  check('the probe sequence is direct, proxy, direct fallback', calls, ['direct', 'proxy', 'direct'])
  check('the last failure surfaces', surfaced, 'ECONNREFUSED')
  check('every attempt was recorded', attempts.map((a) => a.channel), ['direct', 'proxy', 'direct'])
  check('the failures carry their code', attempts.map((a) => a.code), ['ECONNREFUSED', 'ECONNRESET', 'ECONNREFUSED'])
  check('a host nothing answered for is forgotten', state(memory, UNPINNED_HOST), '(none)')
}

// --- 6. A pinned host never probes and never falls back --------------------
{
  const { calls, memory, fetchImpl } = harness({
    forcedProxy: (hostname) => hostname === 'mirror.example',
    proxy: (n) => (n === 0 ? ok() : ok()),
    direct: () => { throw failure('ECONNREFUSED') },
  })
  const response = await fetchImpl(PINNED)
  check('a pinned host is proxied on its first attempt', calls, ['proxy'])
  check('and answers from there', response.status, 200)
  check('a pinned host records no memory', state(memory, 'mirror.example'), '(none)')
}
{
  const { calls, fetchImpl } = harness({
    forcedProxy: (hostname) => hostname === 'mirror.example',
    proxy: () => { throw failure('ECONNREFUSED') },
  })
  let surfaced = false
  try {
    await fetchImpl(PINNED)
  } catch {
    surfaced = true
  }
  check('a pinned host retries its own channel', calls, ['proxy', 'proxy', 'proxy', 'proxy'])
  check('its failure surfaces', surfaced, true)
}

// --- 7. Loopback and LAN never leave the machine ---------------------------
{
  const { calls, memory, fetchImpl } = harness({
    forcedProxy: () => true,
    direct: () => { throw failure('ECONNREFUSED') },
  })
  let surfaced = false
  try {
    await fetchImpl(LOOPBACK)
  } catch {
    surfaced = true
  }
  check('a loopback host is always direct', calls, ['direct', 'direct', 'direct', 'direct'])
  check('its failure surfaces', surfaced, true)
  check('loopback never enters the memory', state(memory, '127.0.0.1'), '(none)')
}

// --- 8. What may be retried is still the transport layer's decision --------
for (const code of ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'ETIMEDOUT']) {
  const { calls, fetchImpl } = harness({
    retryOnPossibleDelivery: false,
    direct: () => { throw failure(code) },
  })
  let surfaced = false
  try {
    await fetchImpl(UNPINNED)
  } catch {
    surfaced = true
  }
  check(code + ' is not retried when possible delivery is off', calls, ['direct'])
  check(code + ' surfaces instead', surfaced, true)
}
{
  // The shipped default retries it — on the other channel, because that is the
  // only channel the host has not just seen fail.
  const { calls, fetchImpl } = harness({ direct: () => { throw failure('ECONNRESET') } })
  const response = await fetchImpl(UNPINNED)
  check('a reset is retried on the proxy by default', calls, ['direct', 'proxy'])
  check('and the caller is answered', response.status, 200)
}
{
  // A code nothing recognises is not retried at all.
  const { calls, fetchImpl } = harness({ direct: () => { throw failure('CERT_HAS_EXPIRED') } })
  let surfaced = false
  try {
    await fetchImpl(UNPINNED)
  } catch {
    surfaced = true
  }
  check('an unrecognised code is not retried', calls, ['direct'])
  check('it surfaces', surfaced, true)
}

// --- 9. The request's own limits are respected -----------------------------
{
  // A streamed body cannot be replayed: sending it twice would truncate it, and
  // aborting it to probe another channel would kill the only copy.
  const { calls, memory, fetchImpl } = harness({ direct: () => { throw failure('ECONNREFUSED') } })
  const body = new ReadableStream({ start(controller) { controller.close() } })
  let surfaced = false
  try {
    await fetchImpl(UNPINNED, { method: 'POST', body, duplex: 'half' })
  } catch {
    surfaced = true
  }
  check('a non-replayable body is sent once', calls, ['direct'])
  check('its failure surfaces', surfaced, true)
  check('it never moves the memory', state(memory, UNPINNED_HOST), '(none)')
}
{
  // A caller that gave up must not have a retry run behind its back.
  const { calls, memory, fetchImpl } = harness({ direct: () => { throw failure('ECONNREFUSED') } })
  const controller = new AbortController()
  controller.abort()
  let surfaced = false
  try {
    await fetchImpl(UNPINNED, { signal: controller.signal })
  } catch {
    surfaced = true
  }
  check('an aborted call is not retried', calls, ['direct'])
  check('the abort surfaces', surfaced, true)
  check('an aborted attempt does not move the memory', state(memory, UNPINNED_HOST), '(none)')
}

// --- 10. An HTTP status is a response, not a failure -----------------------
// It answers the request, so it settles the host like any other answer.
{
  const { calls, memory, fetchImpl } = harness({ direct: () => ok(503) })
  const response = await fetchImpl(UNPINNED)
  check('an HTTP status is not retried', calls, ['direct'])
  check('the status reaches the caller', response.status, 503)
  check('but it still settles the host', state(memory, UNPINNED_HOST), DIRECT_KEPT)
}

// --- 11. The probe sequence is not a retry ---------------------------------
// retryCount 0 means "do not re-dial a channel that answered"; choosing the
// channel in the first place still takes the direct probe and the proxy probe.
{
  const { calls, retries, fetchImpl } = harness({ retryCount: 0, direct: () => silent() })
  const response = await fetchImpl(UNPINNED)
  check('retryCount 0 still probes the other channel once', calls, ['direct', 'proxy'])
  check('the probe is not reported as a retry', retries.length, 0)
  check('and the caller is answered', response.status, 200)
}

// --- 12. An unparseable URL still reaches a channel ------------------------
// The router must never be the reason a request that used to work stopped
// working: a URL with no readable hostname goes direct and is not remembered.
{
  const { calls, memory, attempts, fetchImpl } = harness()
  await fetchImpl('not a url', {})
  check('a malformed URL takes the direct channel', calls, ['direct'])
  check('its record names no host', attempts[0].hostname, '')
  check('nothing was remembered', state(memory, ''), '(none)')
}

// --- 13. A failure with no transport code still moves the host -------------
// The log that prompted this test: direct probe timed out, the proxy attempt
// then failed in 0 ms with no code, and the host stayed on the doomed channel
// for every later request. An unrecognised error must never freeze the choice.
{
  const { calls, memory, fetchImpl } = harness({
    direct: () => { throw new TypeError('fetch failed') },
  })
  const response = await fetchImpl(UNPINNED)
  check('a code-less probe failure moves to the proxy', calls, ['direct', 'proxy'])
  check('the caller is answered', response.status, 200)
  check('and the proxy answer is kept', state(memory, UNPINNED_HOST), PROXY_KEPT)
}
{
  // Both channels fail without a code: the direct fallback still gets its one
  // unbounded attempt instead of the request dying on the second attempt.
  const { calls, memory, fetchImpl } = harness({
    direct: (n) => {
      if (n === 0) throw new TypeError('fetch failed')
      return ok()
    },
    proxy: () => { throw new TypeError('Proxy response !== 200 when HTTP Tunneling') },
  })
  const response = await fetchImpl(UNPINNED)
  check('two code-less failures end in the direct fallback', calls, ['direct', 'proxy', 'direct'])
  check('the fallback answers the caller', response.status, 200)
  check('and settles the host on direct', state(memory, UNPINNED_HOST), DIRECT_KEPT)
}
{
  // A code-less failure on a channel that had answered is the same verdict:
  // probe the other channel once.
  let directMode = 'ok'
  const { calls, memory, fetchImpl } = harness({
    direct: () => {
      if (directMode === 'fail') throw new TypeError('fetch failed')
      return ok()
    },
  })
  await fetchImpl(UNPINNED)
  directMode = 'fail'
  calls.length = 0
  const response = await fetchImpl(UNPINNED)
  check('a code-less failure on a settled channel probes the other', calls, ['direct', 'proxy'])
  check('the rescuing channel answers', response.status, 200)
  check('and is kept', state(memory, UNPINNED_HOST), PROXY_KEPT)
}

// --- 14. The switch still governs resending, not the recorded decision -----
// With "retry possible delivery" off a code-less failure is not resent, but the
// host must still move on — otherwise the next request repeats it forever.
{
  const { calls, memory, fetchImpl } = harness({
    retryOnPossibleDelivery: false,
    direct: () => { throw new TypeError('fetch failed') },
  })
  let surfaced = false
  try {
    await fetchImpl(UNPINNED)
  } catch {
    surfaced = true
  }
  check('a code-less failure is not resent when the switch is off', calls, ['direct'])
  check('it surfaces', surfaced, true)
  check('but the host moves on to the other channel', state(memory, UNPINNED_HOST), PROBE_PROXY)
  const response = await fetchImpl(UNPINNED)
  check('the next request starts on that channel', calls, ['direct', 'proxy'])
  check('and is answered there', response.status, 200)
}

// --- 15. A caller-supplied Request keeps its body across the retry ---------
// The body is consumed when it is read, so a per-attempt normalisation made the
// second attempt fail instantly with "Body is unusable" — a code-less failure
// that looked exactly like the one above.
{
  const { calls, bodies, fetchImpl } = harness({ direct: () => silent() })
  const request = new Request(UNPINNED, {
    method: 'POST',
    body: '{"model":"x"}',
    headers: { 'content-type': 'application/json' },
  })
  const response = await fetchImpl(request)
  check('a Request body is re-sent on the retry', bodies.proxy.map((body) => new TextDecoder().decode(body)), ['{"model":"x"}'])
  check('the retry actually happened', calls, ['direct', 'proxy'])
  check('and the caller is answered', response.status, 200)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
