// Offline test for the per-host channel memory: which channel a host's next
// attempt takes, what settles it, and what does not.
//
// No network and no clock: the memory is pure state (the probe deadline lives in
// the request path), so every transition is asserted exactly. The strategy it
// encodes is the shipped one — a host starts direct, a direct probe that does not
// answer hands the host to the proxy, and the first channel that answers is kept
// for the rest of the session.
import {
  FIRST_CHANNEL,
  PROBE_TIMEOUT_MS,
  RouteMemory,
  describeRouting,
  otherChannel,
} from '../lib/index.js'

let failures = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` -- got ${a}, want ${e}`}`)
}

const HOST = 'api.example'
const OTHER = 'another.example'
const DIRECT = { channel: 'direct', probe: false, fallback: false }
const PROBE_DIRECT = { channel: 'direct', probe: true, fallback: false }
const PROBE_PROXY = { channel: 'proxy', probe: true, fallback: false }
const FALLBACK = { channel: 'direct', probe: false, fallback: true }
const SETTLED_PROXY = { channel: 'proxy', probe: false, fallback: false }

// --- 1. An untouched host starts direct, with the probe budget --------------
{
  const memory = new RouteMemory()
  check('an untouched host starts direct', memory.decide(HOST), PROBE_DIRECT)
  check('the shipped first channel is direct', FIRST_CHANNEL, 'direct')
  check('the shipped probe budget is one second', PROBE_TIMEOUT_MS, 1000)
  check('an untouched host has no state', memory.stateOf(HOST), undefined)
  check('otherChannel flips direct to proxy', otherChannel('direct'), 'proxy')
  check('otherChannel flips proxy to direct', otherChannel('proxy'), 'direct')
}

// --- 2. A silent direct probe hands the host to the proxy -------------------
// This is the user's rule: direct first, and a direct path that did not answer
// inside the budget moves the host onto the proxy with the same budget.
{
  const memory = new RouteMemory()
  check('the first failed direct probe points at the proxy', memory.failed(HOST, 'direct'), PROBE_PROXY)
  check('the host is now probing the proxy', memory.stateOf(HOST), PROBE_PROXY)
}

// --- 3. A proxy probe that also stays silent falls back to direct -----------
// Both channels inconclusive: direct still gets one unbounded attempt, so the
// user is not left with an error that a slightly slower direct path would have
// avoided.
{
  const memory = new RouteMemory()
  memory.failed(HOST, 'direct')
  check('the failed proxy probe falls back to direct', memory.failed(HOST, 'proxy'), FALLBACK)
  check('the fallback is direct, unbounded, and last', memory.stateOf(HOST), FALLBACK)
}

// --- 4. A failed fallback forgets the host ----------------------------------
// Nothing answered, so the next request starts the decision over instead of
// pinning the host to a path that just failed.
{
  const memory = new RouteMemory()
  memory.failed(HOST, 'direct')
  memory.failed(HOST, 'proxy')
  check('a failed fallback has nothing left to try', memory.failed(HOST, 'direct'), undefined)
  check('the host is forgotten', memory.stateOf(HOST), undefined)
  check('the next request starts direct again', memory.decide(HOST), PROBE_DIRECT)
}
// A concurrent request may still be probing the proxy when another one has
// already fallen back to direct. Its failure is stale, not the fallback's: it
// must follow the current decision instead of deleting the state it never saw.
{
  const memory = new RouteMemory()
  memory.failed(HOST, 'direct')
  memory.failed(HOST, 'proxy')
  check('a stale proxy failure keeps the fallback', memory.failed(HOST, 'proxy'), FALLBACK)
  check('and the host is still on the direct fallback', memory.stateOf(HOST), FALLBACK)
}

// --- 5. The channel that answers is kept ------------------------------------
{
  const memory = new RouteMemory()
  memory.settle(HOST, 'direct')
  check('a direct answer settles the host on direct', memory.decide(HOST), DIRECT)
  check('asking again does not move it', memory.decide(HOST), DIRECT)
  check('a second success is a no-op', memory.settle(HOST, 'direct'), undefined)
  check('and it is still direct', memory.stateOf(HOST), DIRECT)
}
{
  const memory = new RouteMemory()
  memory.failed(HOST, 'direct')
  memory.settle(HOST, 'proxy')
  check('an answered probe settles on that channel', memory.decide(HOST), SETTLED_PROXY)
  check('the state names the kept channel', memory.stateOf(HOST), SETTLED_PROXY)
}

// --- 6. A settled channel that fails probes the other one, once -------------
// "If the proxy does not answer in time, go back to direct": a failing proxy is
// not retried forever, and direct is the one it falls back to.
{
  const memory = new RouteMemory()
  memory.settle(HOST, 'direct')
  check('a failed direct settlement probes the proxy', memory.failed(HOST, 'direct'), PROBE_PROXY)
  memory.settle(HOST, 'proxy')
  check('the host is now kept on the proxy', memory.decide(HOST), SETTLED_PROXY)
}
{
  const memory = new RouteMemory()
  memory.settle(HOST, 'proxy')
  check('a failed proxy settlement probes direct', memory.failed(HOST, 'proxy'), PROBE_DIRECT)
  memory.settle(HOST, 'direct')
  check('and answering settles it back on direct', memory.decide(HOST), DIRECT)
}
{
  const memory = new RouteMemory()
  memory.settle(HOST, 'proxy')
  memory.failed(HOST, 'proxy')
  check('a failed direct probe after the proxy falls back to direct', memory.failed(HOST, 'direct'), FALLBACK)
}

// --- 7. The memory is per host ---------------------------------------------
{
  const memory = new RouteMemory()
  memory.settle(HOST, 'proxy')
  check('another host is untouched', memory.decide(OTHER), PROBE_DIRECT)
  check('each host keeps its own channel',
    [memory.decide(HOST).channel, memory.decide(OTHER).channel],
    ['proxy', 'direct'])
  memory.settle(OTHER, 'direct')
  check('the other host settles on its own answer', memory.decide(OTHER), DIRECT)
}

// --- 8. A whole run of successes does not rotate ---------------------------
// The regression this change fixes: a healthy host used to alternate on every
// attempt (direct, proxy, direct, proxy). It must stay on the channel that
// answered.
{
  const memory = new RouteMemory()
  const seen = []
  for (let i = 0; i < 6; i++) {
    seen.push(memory.decide(HOST).channel)
    memory.settle(HOST, memory.decide(HOST).channel)
  }
  check('a healthy host stays on one channel', seen, Array(6).fill('direct'))
}

// --- 9. No timed re-evaluation ---------------------------------------------
// The state only moves on a failure or a settle; there is no clock in here, so
// the same decision keeps coming back however often it is asked.
{
  const memory = new RouteMemory()
  memory.settle(HOST, 'proxy')
  const decisions = []
  for (let i = 0; i < 5; i++) decisions.push(memory.decide(HOST))
  check('asking does not rotate', decisions.every((d) => d.channel === 'proxy' && d.probe === false), true)
}

// --- 10. reset forgets every host -----------------------------------------
{
  const memory = new RouteMemory()
  memory.settle(HOST, 'proxy')
  memory.settle(OTHER, 'direct')
  memory.reset()
  check('reset returns every host to direct', memory.decide(HOST), PROBE_DIRECT)
  check('reset forgets the state', memory.stateOf(HOST), undefined)
  check('reset forgets the other host too', memory.decide(OTHER), PROBE_DIRECT)
}

// --- 11. The mount log names the strategy ----------------------------------
check('describeRouting names the sticky choice',
  describeRouting(4, 1000),
  'route=sticky (direct first with a 1000ms probe, the other channel gets the same probe, the channel that answers is kept; up to 4 attempts)')
check('describeRouting handles a single attempt',
  describeRouting(1, 1000),
  'route=sticky (direct first with a 1000ms probe, the other channel gets the same probe, the channel that answers is kept; up to 1 attempt)')

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
