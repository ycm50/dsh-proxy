// Offline test for the routing fetch: which channel each *attempt* takes, when
// the rotation moves, and the exact conditions under which a failure is retried.
//
// No network: both channels are fakes that record their calls, and the rotation
// is inspected directly. The strategy under test is the shipped one — attempt 1
// goes direct, a failure moves the host to the other channel, and the retry that
// follows takes it — so a run of retries reads direct, proxy, direct, proxy.
import {
  ChannelRotation,
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

/** A transport failure as undici reports it: the code rides on `cause`. */
const failure = (code) => Object.assign(new Error(code), { cause: Object.assign(new Error(code), { code }) })

const ok = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })

/**
 * Two fake channels, a real rotation, and the records the wrapper produces.
 *
 * `calls` is the channel of every attempt in order, so an assertion reads as the
 * sequence the user would see in the log.
 */
function harness(options = {}) {
  const calls = []
  const channels = {
    proxy: async () => { calls.push('proxy'); return options.proxy?.() ?? ok() },
    direct: async () => { calls.push('direct'); return options.direct?.() ?? ok() },
  }
  const rotation = new ChannelRotation()
  const attempts = []
  const retries = []
  const fetchImpl = createRoutingFetch(channels, rotation, {
    retryCount: options.retryCount ?? 3,
    baseDelayMs: options.baseDelayMs ?? 0,
    retryOnPossibleDelivery: options.retryOnPossibleDelivery !== false,
    forcedProxy: options.forcedProxy,
    onAttempt: (attempt) => { attempts.push(attempt) },
    onRetry: (retry) => { retries.push(retry) },
  })
  return { calls, rotation, attempts, retries, fetchImpl }
}

// --- 1. The baseline: a healthy host goes direct, once ---------------------
{
  const { calls, rotation, attempts, retries, fetchImpl } = harness()
  const response = await fetchImpl(UNPINNED)
  check('a healthy request goes direct', calls, ['direct'])
  check('it answers the caller', response.status, 200)
  check('no retry happened', retries.length, 0)
  check('one attempt was recorded', attempts.length, 1)
  check('the record names the channel', attempts[0].channel, 'direct')
  check('the record names the attempt', [attempts[0].attempt, attempts[0].maxAttempts], [1, 4])
  check('the record says it worked', attempts[0].ok, true)
  check('the record carries a duration', typeof attempts[0].ms, 'number')
  // The attempt is over, so the cursor moved: the *next* request from this host
  // takes the other channel.
  check('an answered attempt still moves the cursor', rotation.stateOf(UNPINNED_HOST), 'proxy')
}

// --- 2. A failing host alternates channels on every retry ------------------
{
  const { calls, rotation, attempts, retries, fetchImpl } = harness({ direct: () => { throw failure('ECONNREFUSED') }, proxy: () => { throw failure('ECONNRESET') } })
  let surfaced
  try {
    await fetchImpl(UNPINNED)
  } catch (error) {
    surfaced = error.cause?.code
  }
  check('every attempt alternates', calls, ['direct', 'proxy', 'direct', 'proxy'])
  check('the original error surfaces', surfaced, 'ECONNRESET')
  check('every attempt was recorded', attempts.map((a) => a.channel), ['direct', 'proxy', 'direct', 'proxy'])
  check('the failures carry their code', attempts.map((a) => a.code), ['ECONNREFUSED', 'ECONNRESET', 'ECONNREFUSED', 'ECONNRESET'])
  check('three retries were reported', retries.length, 3)
  check('the retry budget is what stops it', retries[2].maxRetries, 3)
  check('the rotation ends on direct', rotation.stateOf(UNPINNED_HOST), 'direct')
}

// --- 3. One failure is enough to move the host -----------------------------
{
  const { calls, rotation, fetchImpl } = harness({ direct: () => { throw failure('ECONNREFUSED') } })
  const response = await fetchImpl(UNPINNED)
  check('the retry takes the proxy', calls, ['direct', 'proxy'])
  check('the caller never sees the failure', response.status, 200)
  // The answered retry moved the cursor on again, so the *next* request starts
  // direct: both channels stay in use.
  check('the answered retry moves the cursor back to direct', rotation.stateOf(UNPINNED_HOST), 'direct')
}

// --- 4. The rotation continues into the next request -----------------------
// "One direct, one proxy" is the rule for a *host*, not for a single call: the
// next request from DSH picks up where the last one stopped.
{
  const { calls, fetchImpl } = harness({ direct: () => { throw failure('ECONNREFUSED') } })
  await fetchImpl(UNPINNED)
  await fetchImpl(UNPINNED)
  // Request 1: direct fails, proxy answers (cursor -> direct). Request 2 starts
  // where that left it, so the two requests read as one continuous rotation.
  check('the rotation carries into the next request', calls, ['direct', 'proxy', 'direct', 'proxy'])
}
{
  // And once the proxy fails too, the request after that starts direct again.
  const { calls, fetchImpl } = harness({ direct: () => { throw failure('ECONNREFUSED') }, proxy: () => { throw failure('ECONNREFUSED') } })
  try { await fetchImpl(UNPINNED) } catch { /* exhausted */ }
  try { await fetchImpl(UNPINNED) } catch { /* exhausted */ }
  check('the sequence keeps alternating across requests',
    calls,
    ['direct', 'proxy', 'direct', 'proxy', 'direct', 'proxy', 'direct', 'proxy'])
}

// --- 5. A pinned host never alternates -------------------------------------
{
  const { calls, rotation, fetchImpl } = harness({
    forcedProxy: (hostname) => hostname === 'mirror.example',
    direct: () => { throw failure('ECONNREFUSED') },
  })
  const response = await fetchImpl(PINNED)
  check('a pinned host is proxied on its first attempt', calls, ['proxy'])
  check('and answers from there', response.status, 200)
  check('a pinned host records no rotation', rotation.stateOf('mirror.example'), undefined)
}
{
  // Even when the proxy fails, a pinned host does not rotate: it is pinned.
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
  check('a pinned host stays on the proxy', calls, ['proxy', 'proxy', 'proxy', 'proxy'])
  check('its failure surfaces', surfaced, true)
}

// --- 6. Loopback and LAN never leave the machine ---------------------------
{
  const { calls, rotation, fetchImpl } = harness({
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
  check('loopback never enters the rotation', rotation.stateOf('127.0.0.1'), undefined)
}

// --- 7. What may be retried is still the transport layer's decision --------
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
  // The shipped default retries it — on the other channel, because that is what
  // the rotation does.
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

// --- 8. The request's own limits are respected -----------------------------
{
  // A streamed body cannot be replayed: sending it twice would truncate it.
  const { calls, fetchImpl } = harness({ direct: () => { throw failure('ECONNREFUSED') } })
  const body = new ReadableStream({ start(controller) { controller.close() } })
  let surfaced = false
  try {
    await fetchImpl(UNPINNED, { method: 'POST', body, duplex: 'half' })
  } catch {
    surfaced = true
  }
  check('a non-replayable body is sent once', calls, ['direct'])
  check('its failure surfaces', surfaced, true)
}
{
  // A caller that gave up must not have a retry run behind its back.
  const { calls, rotation, fetchImpl } = harness({ direct: () => { throw failure('ECONNREFUSED') } })
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
  // The attempt still happened, so it still hands the next one to the other
  // channel — the rotation is a round-robin, not a verdict on the outcome.
  check('an aborted attempt still moves the cursor', rotation.stateOf(UNPINNED_HOST), 'proxy')
}

// --- 9. An HTTP status is a response, not a failure ------------------------
// It ends the attempt like any other outcome, so it moves the cursor — but it is
// never retried: a status is the server's answer, not a transport failure.
{
  const { calls, rotation, fetchImpl } = harness({ direct: () => new Response('nope', { status: 503 }) })
  const response = await fetchImpl(UNPINNED)
  check('an HTTP status is not retried', calls, ['direct'])
  check('the status reaches the caller', response.status, 503)
  check('but it still moves the cursor', rotation.stateOf(UNPINNED_HOST), 'proxy')
}

// --- 10. The retry budget is configurable ----------------------------------
{
  const { calls, fetchImpl } = harness({ retryCount: 0, direct: () => { throw failure('ECONNREFUSED') } })
  let surfaced = false
  try {
    await fetchImpl(UNPINNED)
  } catch {
    surfaced = true
  }
  check('retryCount 0 sends the request once', calls, ['direct'])
  check('its failure surfaces', surfaced, true)
}
{
  const { calls, fetchImpl } = harness({ retryCount: 1, direct: () => { throw failure('ECONNREFUSED') }, proxy: () => { throw failure('ECONNREFUSED') } })
  try {
    await fetchImpl(UNPINNED)
  } catch {
    // exhausted
  }
  check('retryCount 1 means two attempts', calls, ['direct', 'proxy'])
}

// --- 11. An unparseable URL still reaches a channel ------------------------
// The router must never be the reason a request that used to work stopped
// working: a URL with no readable hostname goes direct and is not rotated.
{
  const { calls, rotation, attempts, fetchImpl } = harness()
  await fetchImpl('not a url', {})
  check('a malformed URL takes the direct channel', calls, ['direct'])
  check('its record names no host', attempts[0].hostname, '')
  check('nothing was rotated', rotation.stateOf(''), undefined)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
