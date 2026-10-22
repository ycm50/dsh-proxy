// Offline test for the request observer: what one request records, that the
// response handed to the caller is untouched, how a fresh connection is told
// apart from a reused one, and what the summary reports.
//
// No network: the wrapped fetch is a fake that plays the channel's part.
import { channel as diagnosticsChannel } from 'node:diagnostics_channel'
import { ProxyObserver, observerFromEnv } from '../lib/index.js'

let failures = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failures++
  console.log((ok ? 'ok  ' : 'FAIL ') + label + (ok ? '' : ' -- got ' + a + ', want ' + e))
}

/** Let the async first-chunk watcher land before asserting on it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

/** A JSON response, the shape a non-streamed call gets. */
const jsonResponse = (status = 200) =>
  new Response('{"ok":true}', { status, headers: { 'content-type': 'application/json' } })

/** An SSE response whose single chunk arrives on demand. */
const sseResponse = () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"token":"hi"}\n\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** The dial channel undici itself publishes on; we play undici here. */
const dials = diagnosticsChannel('undici:client:beforeConnect')

// --- 1. Off unless asked for ------------------------------------------------
check('an empty flag leaves observation off', observerFromEnv(undefined), undefined)
check('an empty string leaves it off', observerFromEnv(''), undefined)
for (const off of ['0', 'false', 'off', 'no', ' OFF ']) {
  check('"' + off + '" leaves it off', observerFromEnv(off), undefined)
}
for (const on of ['1', 'true', 'on', 'yes', 'debug']) {
  const observer = observerFromEnv(on)
  check('"' + on + '" turns it on', observer instanceof ProxyObserver, true)
  observer.dispose()
}

// --- 2. One request, measured, with the caller's response untouched ---------
// A stepped clock makes every duration exact instead of flaky.
let tick = 0
const stepped = () => { tick += 1; return tick }
const logs = []
const observer = new ProxyObserver({ log: (line) => logs.push(line), now: stepped, summaryEvery: 0 })

const original = jsonResponse()
const wrapped = observer.wrapFetch('proxy', async () => original)
const returned = await wrapped('https://api.opencode.ai/v1/models', { method: 'post' })
check('the caller gets the very same response object', returned === original, true)
await settle()
const first = observer.recent()[0]
check('one request is recorded', observer.recent().length, 1)
check('the channel is recorded', first.channel, 'proxy')
check('the method is normalised', first.method, 'POST')
check('only the origin reaches the record', first.origin, 'https://api.opencode.ai')
check('the status is recorded', first.status, 200)
check('time to headers is the stepped clock', first.headersMs, 1)
check('a JSON body reports no first token', first.firstChunkMs, null)
check('no dial means a reused connection', first.freshConnection, false)
check('one log line per request', logs.length, 1)
check('the log line names the channel and the numbers', logs[0].includes('via proxy (reused connection) -> 200 headers=1ms'), true)

// --- 3. A dial during the request marks the connection as fresh -------------
const freshObserver = new ProxyObserver({ now: stepped, summaryEvery: 0 })
const dialing = freshObserver.wrapFetch('proxy', async () => {
  dials.publish({ connectParams: { hostname: 'api.opencode.ai' } })
  return jsonResponse()
})
await dialing('https://api.opencode.ai/v1/models')
await settle()
check('a dial during the request reads as a new connection', freshObserver.recent()[0].freshConnection, true)

// A dial for a different host must not be attributed to this request.
const otherHost = freshObserver.wrapFetch('proxy', async () => {
  dials.publish({ connectParams: { hostname: 'someone.else.example' } })
  return jsonResponse()
})
await otherHost('https://api.opencode.ai/v1/models')
await settle()
check('a dial for another host is not this request', freshObserver.recent()[1].freshConnection, false)

// A dial message without a hostname proves nothing and must not be counted.
const noHostname = freshObserver.wrapFetch('direct', async () => {
  dials.publish({ connectParams: {} })
  dials.publish({})
  return jsonResponse()
})
await noHostname('https://api.opencode.ai/v1/models')
await settle()
check('a hostname-less dial message is ignored', freshObserver.recent()[2].freshConnection, false)

// --- 4. The first streamed chunk is the first token -------------------------
const streaming = new ProxyObserver({ now: stepped, summaryEvery: 0 })
const streamResponse = streaming.wrapFetch('proxy', async () => sseResponse())
const caller = await streamResponse('https://api.opencode.ai/v1/chat/completions')
await settle()
const streamed = streaming.recent()[0]
check('the streamed response still has a readable body', typeof caller.body.getReader, 'function')
check('the first token is timed', typeof streamed.firstChunkMs, 'number')
// The stepped clock advances once per reading, so the token is exactly one tick
// after the headers it followed.
check('the first token is timed after the headers', streamed.firstChunkMs, streamed.headersMs + 1)
// The caller's own body must still deliver the chunk the clone already read.
const text = await caller.text()
check('the caller still reads its own stream', text.includes('"token":"hi"'), true)
check('a cloned body is not drained into memory', streamed.firstChunkMs !== null, true)

// --- 5. A failed attempt is recorded and still rejected ---------------------
const failing = new ProxyObserver({ now: stepped, summaryEvery: 0 })
const boom = new Error('refused')
boom.code = 'ECONNREFUSED'
let rethrown
try {
  await failing.wrapFetch('direct', async () => { throw boom })('https://api.github.com/zen')
} catch (error) {
  rethrown = error
}
check('the original rejection is rethrown', rethrown === boom, true)
check('a failed attempt carries status 0', failing.recent()[0].status, 0)
check('a failed attempt is still timed', typeof failing.recent()[0].headersMs, 'number')

// --- 6. Summary per channel -------------------------------------------------
let clock = 1000
const aggregating = new ProxyObserver({ now: () => clock, summaryEvery: 0 })
const slowProxy = aggregating.wrapFetch('proxy', async () => { clock += 30; return jsonResponse() })
const fastDirect = aggregating.wrapFetch('direct', async () => { clock += 10; return jsonResponse() })
for (let i = 0; i < 4; i++) await slowProxy('https://a.example/1')
for (let i = 0; i < 2; i++) await fastDirect('https://b.example/1')
await settle()
const summary = aggregating.summary()
check('every retained sample is counted', summary.samples, 6)
check('proxy requests are counted separately', [summary.proxy.requests, summary.proxy.fresh], [4, 0])
check('direct requests are counted separately', [summary.direct.requests, summary.direct.fresh], [2, 0])
check('proxy headers are aggregated', [summary.proxy.headersP50, summary.proxy.headersP95], [30, 30])
check('direct headers are aggregated', [summary.direct.headersP50, summary.direct.headersP95], [10, 10])
check('a channel with no tokens reports null', summary.proxy.firstP50, null)

// --- 7. The ring is bounded, and reset clears it ---------------------------
const bounded = new ProxyObserver({ now: stepped, capacity: 3, summaryEvery: 0 })
for (let i = 0; i < 5; i++) await bounded.wrapFetch('proxy', async () => jsonResponse())('https://a.example/' + i)
await settle()
check('the ring keeps only its capacity', bounded.recent().length, 3)
check('recent(limit) takes the newest', bounded.recent(1)[0].origin, 'https://a.example')
bounded.reset()
check('reset drops every sample', bounded.recent().length, 0)
check('reset drops the dial counts too', JSON.stringify(bounded.summary().proxy), JSON.stringify({ requests: 0, fresh: 0, headersP50: 0, headersP95: 0, firstP50: null, firstP95: null }))

// --- 8. A disposed observer records nothing and still fetches --------------
const disposedObserver = new ProxyObserver({ now: stepped, summaryEvery: 0 })
const afterDispose = disposedObserver.wrapFetch('proxy', async () => jsonResponse())
disposedObserver.dispose()
const stillReturned = await afterDispose('https://a.example/x')
check('a disposed observer passes the response through', stillReturned.status, 200)
check('a disposed observer records nothing', disposedObserver.recent().length, 0)
disposedObserver.dispose()

// --- 9. The periodic summary line ------------------------------------------
const summaryLogs = []
const chatting = new ProxyObserver({ log: (line) => summaryLogs.push(line), now: stepped, summaryEvery: 2 })
const chat = chatting.wrapFetch('proxy', async () => jsonResponse())
await chat('https://a.example/1')
await chat('https://a.example/2')
await settle()
check('one line per request plus one summary', summaryLogs.length, 3)
check('the summary names both channels', summaryLogs[2].includes('recent requests') && summaryLogs[2].includes('proxy 2x') && summaryLogs[2].includes('direct 0x'), true)
check('the summary reports percentiles', summaryLogs[2].includes('headers p50='), true)

for (const live of [observer, freshObserver, streaming, failing, aggregating, bounded, chatting]) live.dispose()

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
