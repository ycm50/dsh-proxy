/**
 * Reliability battery for one proxy endpoint, run through DSH's exact
 * transport: the plugin builds `new ProxyAgent(proxyUrl)` and calls undici's
 * `fetch` through it.
 *
 * The battery is the shape a chat actually has — a burst, a quiet gap, then a
 * burst — because a proxy that drops idle tunnels looks fine in a burst-only
 * benchmark and fails the moment the user stops to read.
 *
 * node _smoke/proxy-transport-test.mjs [proxyUrl]
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici'

const URL_UNDER_TEST = 'https://api.commandcode.ai/provider/v1/models'
const PROXY = process.argv[2] ?? 'http://127.0.0.1:10808'
const IDLE_MS = 20_000

const summarise = (label, results) => {
  const ok = results.filter((r) => r.ok)
  const bad = results.filter((r) => !r.ok)
  const times = ok.map((r) => r.ms).sort((a, b) => a - b)
  const line = times.length === 0
    ? 'no successes'
    : `avg ${(times.reduce((a, b) => a + b, 0) / times.length / 1000).toFixed(2)}s  median ${(times[Math.floor(times.length / 2)] / 1000).toFixed(2)}s`
  console.log(`  ${label.padEnd(26)} ok=${String(ok.length).padStart(2)}/${results.length}  ${line}`)
  for (const bad1 of bad.slice(0, 2)) console.log(`      FAIL: ${bad1.error}`)
  return bad.length
}

const one = async (dispatcher) => {
  const started = Date.now()
  try {
    const response = await undiciFetch(URL_UNDER_TEST, dispatcher === undefined ? {} : { dispatcher })
    await response.arrayBuffer()
    return { ok: response.status === 200, ms: Date.now() - started }
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: `${error?.code ?? error?.name}: ${error?.message}` }
  }
}

const sequential = async (n, dispatcher) => {
  const out = []
  for (let i = 0; i < n; i++) out.push(await one(dispatcher))
  return out
}

console.log(`proxy   : ${PROXY}`)
console.log(`target  : ${URL_UNDER_TEST}\n`)

const proxy = new ProxyAgent(PROXY)
let first
for (let attempt = 1; attempt <= 6; attempt++) {
  first = await one(proxy)
  if (first.ok) break
  console.log(`  connectivity attempt ${attempt} failed: ${first.error}`)
  await new Promise((resolve) => setTimeout(resolve, 3000))
}
if (!first.ok) {
  console.log(`  endpoint unusable after 6 attempts: ${first.error}`)
  await proxy.close()
  process.exit(1)
}

let failures = 0
failures += summarise('burst x8', await sequential(8, proxy))
failures += summarise('parallel x5', await Promise.all(Array.from({ length: 5 }, () => one(proxy))))

console.log(`  idling ${IDLE_MS / 1000}s ...`)
await new Promise((resolve) => setTimeout(resolve, IDLE_MS))
failures += summarise('reuse after idle x3', await sequential(3, proxy))

console.log(`  idling ${IDLE_MS / 1000}s again ...`)
await new Promise((resolve) => setTimeout(resolve, IDLE_MS))
failures += summarise('reuse after idle x3', await sequential(3, proxy))

await proxy.close()
console.log(`\n  ${failures === 0 ? 'NO FAILURES' : `${failures} FAILURE(S)`} on ${PROXY}`)
