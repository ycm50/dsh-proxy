/**
 * Concurrency control: does a burst of 5 simultaneous requests lose one
 * because of the proxy, or because the endpoint/network does that anyway?
 *
 * Arounds the same endpoint, once per candidate transport, repeated so a single
 * dropped request cannot decide the answer.
 *
 * node _smoke/proxy-concurrency-test.mjs [rounds]
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici'

const URL_UNDER_TEST = 'https://api.commandcode.ai/provider/v1/models'
const ROUNDS = Number(process.argv[2] ?? 6)
const WIDTH = 5

const candidates = [
  ['direct', undefined],
  ['http://127.0.0.1:10808', new ProxyAgent('http://127.0.0.1:10808')],
  ['socks5://127.0.0.1:10808', new ProxyAgent('socks5://127.0.0.1:10808')],
]

const one = async (dispatcher) => {
  try {
    const response = await undiciFetch(URL_UNDER_TEST, dispatcher === undefined ? {} : { dispatcher })
    await response.arrayBuffer()
    return response.status === 200
  } catch {
    return false
  }
}

console.log(`target: ${URL_UNDER_TEST}   parallel width: ${WIDTH}   rounds: ${ROUNDS}\n`)
for (const [label, dispatcher] of candidates) {
  const outcomes = []
  for (let round = 0; round < ROUNDS; round++) {
    const results = await Promise.all(Array.from({ length: WIDTH }, () => one(dispatcher)))
    const ok = results.filter(Boolean).length
    outcomes.push(ok)
    process.stdout.write(`  ${label.padEnd(26)} round ${round + 1}: ${ok}/${WIDTH}\n`)
  }
  const total = outcomes.reduce((a, b) => a + b, 0)
  const worst = Math.min(...outcomes)
  console.log(`  ${label.padEnd(26)} TOTAL ${total}/${ROUNDS * WIDTH}   worst round ${worst}/${WIDTH}\n`)
}

for (const [, dispatcher] of candidates) if (dispatcher !== undefined) await dispatcher.close()
