// Latency bench for the three transports a model request can take, so a change
// to the request path can be judged by numbers instead of a feeling.
//
// It is deliberately not part of `pnpm test`: it needs the network and a live
// proxy. Run it before and after a transport change and compare the same rows.
//
//   node test/latency-bench.mjs --url https://api.opencode.ai/v1/models \
//        --proxy http://127.0.0.1:10808 --runs 4
//
// Rows, per transport:
//   native  — globalThis.fetch, i.e. what the harness would use without us
//   direct  — this plugin's hardened direct channel
//   proxy   — this plugin's hardened proxy channel
//
// `fresh` means the request had to dial a new connection (read from undici's
// `beforeConnect` channel); `headers` is dispatch to response headers, which is
// the part of a first token that is not the model thinking.
import { ProxyObserver, createHardenedChannel, DEFAULT_STABILITY } from '../lib/index.js'

const options = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (!arg.startsWith('--')) continue
  const name = arg.slice(2)
  const value = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
  options[name] = value
}

const target = options.url ?? 'https://api.opencode.ai/v1/models'
const proxyUrl = options.proxy ?? 'http://127.0.0.1:10808'
const runs = Math.max(1, Number(options.runs ?? 4))
// Idle gap between runs: the pooled-idle window is what a chat's turn cadence
// actually exercises, so `--gap 15000` is the test that a fix keeps a tunnel
// across a think-time pause instead of re-dialling for every message.
const gapMs = Math.max(0, Number(options.gap ?? 0))
// Without a ceiling one stalled request hangs the whole bench — which is exactly
// what a first run of this script did against a flaky edge. The ceiling is per
// request and reported as a note instead of ending the run.
const timeoutMs = Math.max(1000, Number(options.timeout ?? 20000))

/** Pause between runs, standing in for the user reading and typing. */
const idle = (ms) => (ms === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms)))

/** One transport under test: a fetch plus the observer that explains it. */
function transport(label, fetchImpl, observer) {
  return { label, fetch: fetchImpl, observer }
}

const observer = new ProxyObserver({ summaryEvery: 0 })
const stability = { ...DEFAULT_STABILITY, retryCount: 0 }
const directChannel = createHardenedChannel(undefined, { stability, observer })
const proxyChannel = createHardenedChannel(proxyUrl, { stability, observer })

const transports = [
  transport('native', globalThis.fetch.bind(globalThis), undefined),
  transport('direct', directChannel.fetch, observer),
  transport('proxy', proxyChannel.fetch, observer),
]

const pad = (value, width) => String(value).padEnd(width)
const rows = []
for (const entry of transports) {
  const before = entry.observer === undefined ? 0 : observer.recent().length
  for (let run = 1; run <= runs; run++) {
    if (run > 1) await idle(gapMs)
    const started = performance.now()
    let status = 0
    let failed = ''
    try {
      const response = await entry.fetch(target, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      status = response.status
      // Drain so the connection returns to the pool, which is what makes the
      // next run a genuine reuse test rather than a "socket still busy" test.
      await response.arrayBuffer()
    } catch (error) {
      failed = error?.code ?? String(error?.message ?? error).slice(0, 40)
    }
    const wall = Math.round(performance.now() - started)
    let fresh = null
    let headers = null
    let first = null
    if (entry.observer !== undefined) {
      const sample = entry.observer.recent().slice(before).at(-1)
      if (sample !== undefined) {
        fresh = sample.freshConnection
        headers = sample.headersMs
        first = sample.firstChunkMs
      }
    }
    rows.push({
      transport: entry.label,
      run,
      status,
      fresh,
      headers,
      first,
      wall,
      failed,
    })
  }
}

console.log('target ' + target)
console.log('proxy  ' + proxyUrl + '  (runs per transport: ' + String(runs) + ')')
console.log('')
console.log(pad('#', 3) + pad('transport', 10) + pad('status', 8) + pad('conn', 10) + pad('headers', 10) + pad('first', 9) + pad('wall', 8) + 'note')
for (const row of rows) {
  const connection = row.fresh === null ? '-' : (row.fresh ? 'fresh' : 'reused')
  const first = row.first === null || row.first === undefined ? '-' : String(row.first) + 'ms'
  console.log(
    pad(row.run, 3)
    + pad(row.transport, 10)
    + pad(row.status, 8)
    + pad(connection, 10)
    + pad(row.headers === null ? '-' : String(row.headers) + 'ms', 10)
    + pad(first, 9)
    + pad(String(row.wall) + 'ms', 8)
    + row.failed,
  )
}

/** Median of the header times of one transport, ignoring failures. */
const medianOf = (label) => {
  const values = rows
    .filter((row) => row.transport === label && row.failed === '' && row.headers !== null)
    .map((row) => row.headers)
    .sort((left, right) => left - right)
  if (values.length === 0) return null
  return values[Math.floor(values.length / 2)]
}

console.log('')
for (const entry of transports) {
  const freshCount = rows.filter((row) => row.transport === entry.label && row.fresh === true).length
  const median = medianOf(entry.label)
  console.log(pad(entry.label, 10) + 'median headers ' + String(median ?? 'n/a') + 'ms'
    + '   fresh connections ' + String(freshCount) + '/' + String(runs))
}

await directChannel.close()
await proxyChannel.close()
observer.dispose()
