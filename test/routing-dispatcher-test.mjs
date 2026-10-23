// Offline test for the process-wide dispatch layer: the built-in exemption
// rules (loopback + private networks), the per-request channel choice, the
// fail-open path, teardown propagation, and the multi-instance install stack.
//
// No network: both channels are fakes that record which one a request reached.
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import {
  RouteMemory,
  RoutingDispatcher,
  installGlobalDispatcher,
  isExemptHostname,
  isLanHostname,
  liveDispatcherCount,
  uninstallGlobalDispatcher,
} from '../lib/index.js'

let failures = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failures++
  console.log((ok ? 'ok  ' : 'FAIL ') + label + (ok ? '' : ' -- got ' + a + ', want ' + e))
}

// --- 1. Exemptions: loopback -------------------------------------------------
check('loopback 127.0.0.1', isExemptHostname('127.0.0.1'), true)
check('loopback 127.9.9.9', isExemptHostname('127.9.9.9'), true)
check('loopback localhost', isExemptHostname('localhost'), true)
check('loopback ::1', isExemptHostname('::1'), true)
check('loopback [::1]', isExemptHostname('[::1]'), true)
check('loopback mapped', isExemptHostname('::ffff:127.0.0.1'), true)

// --- 2. Exemptions: private / local networks --------------------------------
for (const host of ['10.1.2.3', '192.168.0.9', '172.16.0.1', '172.31.255.255', '169.254.1.1', '100.64.0.1', '0.0.0.0', 'fd00::1', 'fcff::2', 'fe80::1', 'febf::9', 'nas.local', 'box.lan', 'svc.internal', 'dev.home.arpa', 'printer']) {
  check('lan exempt ' + host, isExemptHostname(host), true)
}
// The ranges' neighbours must NOT be treated as private.
for (const host of ['172.15.0.1', '172.32.0.1', '11.0.0.1', '100.63.0.1', '100.128.0.1', '192.169.0.1', '8.8.8.8']) {
  check('public not exempt ' + host, isExemptHostname(host), false)
}
check('public not exempt zzz.wbzai.cn', isExemptHostname('zzz.wbzai.cn'), false)
check('public not exempt api.github.com', isExemptHostname('api.github.com'), false)
check('isLanHostname agrees', isLanHostname('192.168.1.1'), true)

// --- 3. Channel choice -------------------------------------------------------
const log = []
const channel = (name) => ({
  name,
  dispatch(options) {
    log.push(name)
    log.push(String(options.origin))
    return true
  },
  close(callback) {
    log.push(name + ':close')
    if (callback === undefined) return Promise.resolve()
    callback()
    return undefined
  },
  destroy(err, callback) {
    log.push(name + ':destroy')
    if (typeof err === 'function') {
      err()
      return undefined
    }
    if (callback !== undefined) {
      callback()
      return undefined
    }
    return Promise.resolve()
  },
})

const direct = channel('direct')
const proxied = channel('proxied')
const routing = new RoutingDispatcher({
  direct,
  proxied,
  channelFor: (host) => (host.endsWith('.wbzai.cn') ? 'proxy' : 'direct'),
})

const call = (origin) => {
  log.length = 0
  routing.dispatch(origin === undefined ? {} : { origin }, {})
  return log[0]
}
check('listed host goes through the proxy', call('https://zzz.wbzai.cn/v1/models'), 'proxied')
check('unlisted host stays on our direct channel', call('https://api.github.com/zen'), 'direct')

// Exemptions outrank the routed list: even a predicate that says "proxy everything".
const forceAll = new RoutingDispatcher({ direct, proxied, channelFor: () => 'proxy' })
const callAll = (origin) => {
  log.length = 0
  forceAll.dispatch({ origin }, {})
  return log[0]
}
check('loopback is never proxied', callAll('http://127.0.0.1:19387/'), 'direct')
check('localhost is never proxied', callAll('http://localhost:3000/'), 'direct')
check('private v4 is never proxied', callAll('http://192.168.1.20:8080/v1'), 'direct')
check('private v6 is never proxied', callAll('http://[fd00::5]/x'), 'direct')
check('a listed public host still proxies', callAll('https://zzz.wbzai.cn/v1'), 'proxied')

// Fail-open: an origin we cannot parse takes the direct channel instead of throwing.
check('malformed origin fails open', callAll('not a url at all'), 'direct')
check('missing origin fails open', call('undefined-origin-holder'), 'direct')
log.length = 0
check('dispatch with no origin returns the channel result', routing.dispatch({}, {}), true)
check('no origin goes direct', log[0], 'direct')

// --- 3b. The dispatcher path settles the same memory the wrapper does ------
// Callers that captured `fetch` before this plugin mounted reach the network
// through this dispatcher and never touch the wrapper, so the choice has to be
// settled from here too: a failure moves the host to the other channel once and
// response headers keep it. Without this those callers keep landing on the
// channel that just failed — "four attempts, none of them connected".
{
  const seen = []
  const outcomes = []
  const memory = new RouteMemory()
  const failing = {
    dispatch(_options, handler) {
      seen.push('direct')
      handler?.onError?.(Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }))
      return true
    },
    close: async () => {}, destroy: async () => {},
  }
  const working = {
    dispatch(_options, handler) {
      seen.push('proxy')
      handler?.onHeaders?.(200, [], () => {}, 'OK')
      return true
    },
    close: async () => {}, destroy: async () => {},
  }
  const observed = new RoutingDispatcher({
    direct: failing,
    proxied: working,
    channelFor: (host) => memory.decide(host).channel,
    learnFor: (host) => !isExemptHostname(host),
    onOutcome: (record) => {
      if (record.ok) memory.settle(record.hostname, record.channel)
      else memory.failed(record.hostname, record.channel)
      outcomes.push(record)
    },
  })
  const handler = { onConnect() {}, onHeaders() { return false }, onData() { return false }, onComplete() {}, onError() {} }
  const call = () => observed.dispatch({ origin: 'https://api.example', path: '/v1/chat', method: 'POST' }, handler)
  call()  // direct, fails -> the memory probes the proxy
  call()  // proxy, answers -> settles on the proxy
  call()  // proxy again: the answer is kept
  check('the dispatcher path settles and then stays', seen, ['direct', 'proxy', 'proxy'])
  check('the failure is recorded with its channel and code',
    [outcomes[0].ok, outcomes[0].channel, outcomes[0].code], [false, 'direct', 'ECONNREFUSED'])
  check('an answered dispatch is recorded as ok',
    [outcomes[1].ok, outcomes[1].channel, typeof outcomes[1].ms], [true, 'proxy', 'number'])
  check('the memory keeps the proxy', memory.decide('api.example'),
    { channel: 'proxy', probe: false, fallback: false })

  // A loopback/LAN host has no channel to decide, so it is not observed at all.
  seen.length = 0
  observed.dispatch({ origin: 'http://127.0.0.1:9/x' }, handler)
  check('an exempt host takes direct and is never observed',
    [seen, memory.stateOf('127.0.0.1') ?? '(none)'], [['direct'], '(none)'])
}

// --- 4. Teardown propagation -------------------------------------------------
log.length = 0
await routing.close()
check('close reaches both channels', log.slice().sort(), ['direct:close', 'proxied:close'])
log.length = 0
routing.destroy(null)
check('destroy reaches both channels', log.slice().sort(), ['direct:destroy', 'proxied:destroy'])

// --- 5. Install stack -------------------------------------------------------
const baseline = getGlobalDispatcher()
check('no installs at rest', liveDispatcherCount(), 0)

const tokenA = Symbol('a')
const tokenB = Symbol('b')
installGlobalDispatcher(tokenA, direct)
check('first install takes the slot', getGlobalDispatcher(), direct)
installGlobalDispatcher(tokenB, proxied)
check('second install is newest', getGlobalDispatcher(), proxied)
check('both live', liveDispatcherCount(), 2)
uninstallGlobalDispatcher(tokenA)
check('retiring a non-newest install leaves the newest routing', getGlobalDispatcher(), proxied)
uninstallGlobalDispatcher(tokenB)
check('the last retire restores the machine own dispatcher', getGlobalDispatcher(), baseline)
check('stack is empty again', liveDispatcherCount(), 0)
check('uninstalling an unknown token is a no-op', uninstallGlobalDispatcher(Symbol('c')), false)

// A foreign replacement after our install is not ours to undo.
const foreign = channel('foreign')
const tokenD = Symbol('d')
installGlobalDispatcher(tokenD, direct)
setGlobalDispatcher(foreign)
uninstallGlobalDispatcher(tokenD)
check('a foreign dispatcher installed after us survives our retire', getGlobalDispatcher(), foreign)
setGlobalDispatcher(baseline)
check('baseline restored for later tests', getGlobalDispatcher(), baseline)

console.log(failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECKS FAILED')
if (failures > 0) process.exit(1)
