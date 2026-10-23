// Offline test for the probe timeline: the phase breakdown a failed probe
// carries, so "the tunnel never opened" and "the tunnel opened instantly but the
// answer never came" stop reading as the same PROBE_TIMEOUT.
//
// The listeners are driven here with hand-made diagnostics payloads — the shapes
// undici publishes (verified against undici 7 on this machine) — so the test
// needs no socket and no clock.
import { channel as diagnosticsChannel } from 'node:diagnostics_channel'
import { describeTimeline, openProbeTracker } from '../lib/index.js'

let failures = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failures++
  console.log((ok ? 'ok  ' : 'FAIL ') + label + (ok ? '' : ' -- got ' + a + ', want ' + e))
}

const publish = (name, payload) => { diagnosticsChannel(name).publish(payload) }

// --- 1. Nothing observed reads as nothing -----------------------------------
{
  const tracker = openProbeTracker('https://a.example', 'a.example')
  check('an attempt with no events has an empty timeline', tracker.finish(), {})
  tracker.dispose()
}

// --- 2. The tunnel opened, the headers never came ---------------------------
// The shape the real log shows for a proxy probe: connected fires, headers do
// not, so the budget ran out with a live tunnel.
{
  const tracker = openProbeTracker('https://a.example', 'a.example')
  publish('undici:client:connected', { connectParams: { hostname: 'a.example' }, connector: {}, socket: {} })
  const timeline = tracker.finish()
  check('a connect is recorded', typeof timeline.connectMs, 'number')
  check('a missing header is not recorded', timeline.headersMs, undefined)
  tracker.dispose()
}

// --- 3. The dial itself failed ---------------------------------------------
{
  const tracker = openProbeTracker('https://b.example', 'b.example')
  publish('undici:client:connectError', {
    connectParams: { hostname: 'b.example' },
    connector: {},
    error: Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
  })
  check('a connect failure carries its code', tracker.finish().connectError, 'ECONNRESET')
  tracker.dispose()
}

// --- 4. Headers arrived, and the phases line up in the log ------------------
{
  const tracker = openProbeTracker('https://c.example', 'c.example')
  const request = { origin: 'https://c.example', path: '/v1/models' }
  publish('undici:request:create', { request })
  publish('undici:client:connected', { connectParams: { hostname: 'c.example' }, connector: {}, socket: {} })
  publish('undici:request:headers', { request, response: { statusCode: 200 } })
  const timeline = tracker.finish()
  check('both phases are recorded', [typeof timeline.connectMs, typeof timeline.headersMs], ['number', 'number'])
  check('the line names both phases',
    describeTimeline({ connectMs: 14, headersMs: 1421 }),
    'connect=14ms headers=1421ms')
  check('the line names a connect failure',
    describeTimeline({ connectError: 'ETIMEDOUT' }),
    'connect-error=ETIMEDOUT')
  check('an empty timeline renders as nothing', describeTimeline({}), '')
  tracker.dispose()
}

// --- 5. Another host's events do not leak in -------------------------------
{
  const tracker = openProbeTracker('https://d.example', 'd.example')
  const foreign = { origin: 'https://other.example', path: '/' }
  publish('undici:request:create', { request: foreign })
  publish('undici:client:connected', { connectParams: { hostname: 'other.example' }, connector: {}, socket: {} })
  publish('undici:request:headers', { request: foreign, response: { statusCode: 200 } })
  check('events for another host are ignored', tracker.finish(), {})
  tracker.dispose()
}

// --- 5b. A neighbour's answer on the same origin is not this attempt's -----
// The regression this guards: headers used to be matched by origin, so a
// concurrent request to the same host could answer a probe that itself timed
// out -- the log read 'failed PROBE_TIMEOUT in 3005ms [headers=1274ms]', a
// contradiction that would have pointed the next fix in the wrong direction.
{
  const mine = openProbeTracker('https://same.example', 'same.example')
  const theirs = openProbeTracker('https://same.example', 'same.example')
  const myRequest = { origin: 'https://same.example', path: '/mine' }
  const theirRequest = { origin: 'https://same.example', path: '/theirs' }
  publish('undici:request:create', { request: myRequest })
  publish('undici:request:create', { request: theirRequest })
  publish('undici:request:headers', { request: theirRequest, response: { statusCode: 200 } })
  check('the neighbour keeps its own answer', typeof theirs.finish().headersMs, 'number')
  check('and this attempt stays unanswered', mine.finish().headersMs, undefined)
  mine.dispose()
  theirs.dispose()
}

// --- 6. A finished tracker stops recording --------------------------------
{
  const tracker = openProbeTracker('https://e.example', 'e.example')
  const before = tracker.finish()
  publish('undici:client:connected', { connectParams: { hostname: 'e.example' }, connector: {}, socket: {} })
  check('a finished tracker keeps its answer', tracker.finish(), before)
  tracker.dispose()
  check('the second dispose is harmless', tracker.dispose(), undefined)
}

// --- 7. Nothing is subscribed once every tracker is gone ------------------
// The channels are process-wide; leaving listeners behind would make every later
// request pay for a probe nobody is reading.
{
  const tracker = openProbeTracker('https://f.example', 'f.example')
  tracker.dispose()
  check('no listener is left behind', diagnosticsChannel('undici:client:connected').hasSubscribers, false)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
