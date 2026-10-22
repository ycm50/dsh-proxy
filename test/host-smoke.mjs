// Runtime smoke test for the ported host half: the volatile config contract,
// default handling, readConfig unwrapping, umbrella host matching, exclusion
// precedence, and URL validation.
import {
  Config,
  DEFAULT_STABILITY,
  POOLED_IDLE_WINDOW_MS,
  SUPPORTED_PROXY_SCHEMES,
  TCP_KEEPALIVE_DELAY_MS,
  agentOptionsOf,
  assertValid,
  describeStability,
  isExemptHostname,
  matchesHostEntry,
  normalizeHostEntry,
  readConfig,
  readStability,
  shouldProxy,
  stabilityIsDefault,
} from '../lib/index.js'

let failures = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` -- got ${a}, want ${e}`}`)
}

/** Build a normalized set exactly the way the Host half does. */
const setOf = (...entries) => {
  const hosts = new Set()
  for (const entry of entries) {
    const normalized = normalizeHostEntry(entry)
    if (normalized !== undefined) hosts.add(normalized)
  }
  return hosts
}

// --- 1. The volatile config contract ---------------------------------------
const empty = Config({})
check('empty proxy', readConfig(empty).proxy, '')
check('empty proxyHosts', readConfig(empty).proxyHosts, [])
check('empty excludeHosts', readConfig(empty).excludeHosts, [])
check('fields are volatile references', typeof empty.proxy.get, 'function')
check('useSystemProxy rests at false', readConfig(empty).useSystemProxy, false)

const parsed = Config({
  proxy: 'socks5://127.0.0.1:7890',
  proxyHosts: ['gateway.acme.example', '.aiplatform.googleapis.com'],
  excludeHosts: ['api.deepseek.com'],
})
check('proxy', readConfig(parsed).proxy, 'socks5://127.0.0.1:7890')
check('proxyHosts', readConfig(parsed).proxyHosts, ['gateway.acme.example', '.aiplatform.googleapis.com'])
check('excludeHosts', readConfig(parsed).excludeHosts, ['api.deepseek.com'])
check('a section without the switch reads as off', readConfig(parsed).useSystemProxy, false)
check('the system-proxy switch is read back', readConfig(Config({ useSystemProxy: true })).useSystemProxy, true)

// --- 2. Entries are umbrellas: a domain covers its whole subtree ------------
check('a plain domain normalizes to itself', normalizeHostEntry('commandcode.ai'), 'commandcode.ai')
check('a wildcard folds onto the same entry', normalizeHostEntry('*.commandcode.ai'), '.commandcode.ai')
check('a dotted entry folds onto the same entry', normalizeHostEntry('.commandcode.ai'), '.commandcode.ai')
check('a pasted URL keeps only its host', normalizeHostEntry('https://api.commandcode.ai/v1'), 'api.commandcode.ai')
check('host:port drops the port', normalizeHostEntry('gateway.acme.example:8443'), 'gateway.acme.example')

const saved = setOf('commandcode.ai') // exactly what is saved in the profile
check('the umbrella itself matches', shouldProxy('https://commandcode.ai/', saved), true)
check('a one-level child matches', shouldProxy('https://api.commandcode.ai/provider/v1', saved), true)
check('a child matches at any depth', shouldProxy('https://a.b.c.d.commandcode.ai/', saved), true)
check('a hyphen sibling matches (region hosts)', shouldProxy('https://eu-commandcode.ai/', saved), true)
check('an unrelated domain does not match', shouldProxy('https://api.deepseek.com/v1', saved), false)
check('a lookalike suffix does not match', shouldProxy('https://notcommandcode.ai/', saved), false)

// The three spellings of one umbrella are interchangeable.
for (const [label, set] of [['dotted', setOf('.commandcode.ai')], ['wildcard', setOf('*.commandcode.ai')]]) {
  check(`${label} spelling reaches the same child`, shouldProxy('https://api.commandcode.ai/v1', set), true)
  check(`${label} spelling reaches deep children`, shouldProxy('https://x.y.commandcode.ai/', set), true)
}

// Vertex/Azure region endpoints: the umbrella reaches the hyphen sibling.
const vertex = setOf('aiplatform.googleapis.com')
check('vertex region host via a plain umbrella', shouldProxy('https://us-central1-aiplatform.googleapis.com/v1', vertex), true)
check('vertex bare domain matches too', shouldProxy('https://aiplatform.googleapis.com/', vertex), true)

// --- 3. Exclusions win, with the same umbrella semantics --------------------
const routed = setOf('commandcode.ai', 'api.deepseek.com')
check('baseline: the child is routed', shouldProxy('https://api.commandcode.ai/v1', routed), true)
check(
  'excluding the umbrella keeps the whole subtree direct',
  shouldProxy('https://api.commandcode.ai/v1', routed, setOf('commandcode.ai')),
  false,
)
check(
  'excluding one child carves only that child back out',
  shouldProxy('https://api.commandcode.ai/v1', routed, setOf('api.commandcode.ai')),
  false,
)
check(
  'excluding one child leaves its siblings routed',
  shouldProxy('https://other.commandcode.ai/v1', routed, setOf('api.commandcode.ai')),
  true,
)
check(
  'excluding a plain domain reaches an exact auto-mode host (the old bug)',
  shouldProxy('https://api.deepseek.com/v1', routed, setOf('deepseek.com')),
  false,
)
check(
  'an exclusion that matches nothing changes nothing',
  shouldProxy('https://api.commandcode.ai/v1', routed, setOf('example.org')),
  true,
)
check(
  'exclusions apply in explicit mode too',
  shouldProxy('https://a.b.commandcode.ai/', saved, setOf('.commandcode.ai')),
  false,
)

// --- 4. URL validation -----------------------------------------------------
for (const scheme of SUPPORTED_PROXY_SCHEMES) {
  let thrown
  try { assertValid({ proxy: `${scheme}://127.0.0.1:1080` }) } catch (error) { thrown = error }
  check(`assertValid accepts ${scheme}:`, thrown === undefined, true)
}
let rejected
try { assertValid({ proxy: 'ftp://127.0.0.1:1080' }) } catch (error) { rejected = error.message }
check('assertValid rejects an unsupported scheme', typeof rejected, 'string')
let malformed
try { assertValid({ proxy: 'not a url' }) } catch (error) { malformed = error.message }
check('assertValid rejects a malformed URL', typeof malformed, 'string')
check('assertValid accepts an empty proxy', assertValid({ proxy: '' }), undefined)

// --- 4b. The routing contract, stated as the settings page states it -------
// The list is the whole policy: listed hosts and their subdomains are routed,
// nothing else is, and an exclusion outranks the list entirely. These are the
// rules the page's copy promises, so they are asserted here against the same
// function the wrapper uses.
const contract = setOf('proxy.example')
check('a listed host is routed', shouldProxy('https://proxy.example/x', contract), true)
check('a subdomain of a listed host is routed', shouldProxy('https://api.proxy.example/x', contract), true)
check('a deep subdomain is routed', shouldProxy('https://a.b.proxy.example/x', contract), true)
check('an unlisted host stays direct', shouldProxy('https://other.example/x', contract), false)
check('a lookalike host stays direct', shouldProxy('https://xproxy.example/x', contract), false)

// An empty list routes nothing: there is no auto-detected set behind it.
check('an empty list routes nothing', shouldProxy('https://api.deepseek.com/x', new Set()), false)
check('an empty list routes nothing even for a model host', shouldProxy('https://any.example/x', new Set()), false)

// An exclusion is the highest-priority input there is.
check('an exclusion outranks the list', shouldProxy('https://proxy.example/x', contract, setOf('proxy.example')), false)
check('an exclusion outranks the list for a child', shouldProxy('https://api.proxy.example/x', contract, setOf('proxy.example')), false)
check('an exclusion of one child leaves its sibling routed', shouldProxy('https://api.proxy.example/x', contract, setOf('other.proxy.example')), true)

// Loopback is direct without the list being consulted at all.
check('loopback stays direct even when listed', shouldProxy('http://127.0.0.1:9/x', setOf('127.0.0.1')), false)
check('localhost stays direct even when listed', shouldProxy('http://localhost:9/x', setOf('localhost')), false)
check('loopback is not matched as a suffix', shouldProxy('https://127.0.0.1.evil.example/x', contract), false)

// An unparseable URL has no hostname to judge, so it never travels.
check('an unparseable URL is never routed', shouldProxy('notaurl', contract), false)

// --- 5. The matching helper is exported for the browser half ---------------
check('matchesHostEntry is usable directly', matchesHostEntry('api.a.b', 'a.b'), true)
check('matchesHostEntry rejects a non-child', matchesHostEntry('xay.b', 'a.b'), false)

// --- 6. The stability contract ---------------------------------------------
// These knobs are what the request path is built from, so their defaults,
// clamping, and translation into agent options are asserted rather than
// trusted. The failures measured on this machine — a 10.5 s CONNECT through
// the local proxy, and a 10.373 s direct connect that spent 0.0 ms of CPU —
// are exactly what the shipped defaults exist to clear.
const stock = readConfig(Config({}))
check('connect timeout ships at 60s', stock.stability.connectTimeoutMs, DEFAULT_STABILITY.connectTimeoutMs)
check('response timeout ships at 5m', stock.stability.responseTimeoutMs, 300000)
check('the stream watchdog ships off', stock.stability.streamIdleTimeoutMs, 0)
check('the retry budget ships at 3x400ms', [stock.stability.retryCount, stock.stability.retryDelayMs], [3, 400])
check('possible-delivery retries ship on', stock.stability.retryOnPossibleDelivery, true)
check('the shipped snapshot reads as stock', stabilityIsDefault(stock.stability), true)

const tuned = readConfig(Config({ connectTimeoutMs: 120000, retryCount: 0, streamIdleTimeoutMs: 45000 }))
check('a stored connect timeout is honoured', tuned.stability.connectTimeoutMs, 120000)
check('retries can be switched off', tuned.stability.retryCount, 0)
check('a stored stream window is honoured', tuned.stability.streamIdleTimeoutMs, 45000)
check('a tuned snapshot is not stock', stabilityIsDefault(tuned.stability), false)

const repaired = []
const clamped = readConfig(Config({ connectTimeoutMs: 10, responseTimeoutMs: 99999999 }), (message) => repaired.push(message))
check('a too-small connect timeout clamps up', clamped.stability.connectTimeoutMs, 1000)
check('a too-large response timeout clamps down', clamped.stability.responseTimeoutMs, 3600000)
check('each repair is reported', repaired.length, 2)

// A context that predates a field must read the default, never throw.
const partial = readConfig({ proxy: { get: () => 'http://127.0.0.1:1' }, proxyHosts: { get: () => [] } })
check('an absent stability field reads its default', partial.stability.connectTimeoutMs, DEFAULT_STABILITY.connectTimeoutMs)
check('an absent proxy list reads empty', partial.proxyHosts, [])
check('readStability tolerates nothing at all', readStability(undefined).connectTimeoutMs, 60000)

const options = agentOptionsOf(stock.stability)
check('the connect ceiling reaches the agent', options.connectTimeout, 60000)
check('the CONNECT tunnel shares that ceiling', options.connect.timeout, 60000)
check('TCP keepalive is on', options.connect.keepAlive, true)
check('keepalive probes start at 30s', options.connect.keepAliveInitialDelay, TCP_KEEPALIVE_DELAY_MS)
check('the pooled idle window is bounded', options.keepAliveMaxTimeout, POOLED_IDLE_WINDOW_MS)
check('a zero stream window disables the watchdog', options.bodyTimeout, 0)
check('autoSelectFamily is on', options.connect.autoSelectFamily, true)
check('undici is not allowed to wait out a hung handshake', options.connectTimeout > 10000, true)
check('describeStability summarises the budget', describeStability(stock.stability), 'connect=60s headers=300s body=off retry=3x400ms')
check('describeStability flags safe-only retries', describeStability({ ...stock.stability, retryOnPossibleDelivery: false }), 'connect=60s headers=300s body=off retry=3x400ms retry-safe-only')

// --- 6b. Private networks never travel --------------------------------------
for (const host of ['10.1.2.3', '192.168.1.9', '172.20.0.1', '169.254.1.1', '100.64.0.1', 'fd00::1', 'fe80::1', 'nas.local']) {
  check('a private host stays direct when listed: ' + host, shouldProxy('http://' + host + '/x', setOf(host)), false)
}
check('a public host in the same list still routes', shouldProxy('https://proxy.example/x', setOf('proxy.example', '10.0.0.1')), true)
check('isExemptHostname covers loopback too', isExemptHostname('127.0.0.1'), true)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
