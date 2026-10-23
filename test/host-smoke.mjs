// Runtime smoke test for the ported host half: the volatile config contract,
// default handling, readConfig unwrapping, umbrella host matching, the force
// list, the built-in loopback/LAN exemption, and URL validation.
import {
  Config,
  DEFAULT_STABILITY,
  HAPPY_EYEBALLS_ATTEMPT_MS,
  POOLED_IDLE_MAX_MS,
  POOLED_IDLE_WINDOW_MS,
  STABILITY_BOUNDS,
  SUPPORTED_PROXY_SCHEMES,
  TCP_KEEPALIVE_DELAY_MS,
  agentOptionsOf,
  assertValid,
  connectorOptionsOf,
  describeRouting,
  describeStability,
  headerPairs,
  isExemptHostname,
  matchesHostEntry,
  normaliseFetchCall,
  normalizeHostEntry,
  readConfig,
  readStability,
  shouldForceProxy,
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
check('empty forceHosts', readConfig(empty).forceHosts, [])
check('fields are volatile references', typeof empty.proxy.get, 'function')
check('useSystemProxy rests at false', readConfig(empty).useSystemProxy, false)
check('proxySubprocesses rests at false', readConfig(empty).proxySubprocesses, false)

const parsed = Config({
  proxy: 'socks5://127.0.0.1:7890',
  forceHosts: ['mirror.example', '.aiplatform.googleapis.com'],
})
check('proxy', readConfig(parsed).proxy, 'socks5://127.0.0.1:7890')
check('forceHosts', readConfig(parsed).forceHosts, ['mirror.example', '.aiplatform.googleapis.com'])
check('a section without the switch reads as off', readConfig(parsed).useSystemProxy, false)
check('the system-proxy switch is read back', readConfig(Config({ useSystemProxy: true })).useSystemProxy, true)
check('the subprocess switch is read back', readConfig(Config({ proxySubprocesses: true })).proxySubprocesses, true)
// The attempt record is a switch, not a default: a diagnostic that writes files
// unasked is a surprise.
check('the record switch ships off', readConfig(empty).debugLog, false)
check('a section without the record switch reads as off', readConfig(parsed).debugLog, false)
check('the record switch is read back', readConfig(Config({ debugLog: true })).debugLog, true)

// A context that predates a field must read the default, never throw.
const partial = readConfig({ proxy: { get: () => 'http://127.0.0.1:1' } })
check('an absent force list reads empty', partial.forceHosts, [])
check('an absent stability field reads its default', partial.stability.connectTimeoutMs, DEFAULT_STABILITY.connectTimeoutMs)
check('readStability tolerates nothing at all', readStability(undefined).connectTimeoutMs, 60000)

// --- 2. Entries are umbrellas: a domain covers its whole subtree ------------
check('a plain domain normalizes to itself', normalizeHostEntry('commandcode.ai'), 'commandcode.ai')
check('a wildcard folds onto the same entry', normalizeHostEntry('*.commandcode.ai'), '.commandcode.ai')
check('a dotted entry folds onto the same entry', normalizeHostEntry('.commandcode.ai'), '.commandcode.ai')
check('a pasted URL keeps only its host', normalizeHostEntry('https://api.commandcode.ai/v1'), 'api.commandcode.ai')
check('host:port drops the port', normalizeHostEntry('gateway.acme.example:8443'), 'gateway.acme.example')
check('an empty entry is nothing', normalizeHostEntry('   '), undefined)

const saved = setOf('commandcode.ai') // exactly what is saved in the profile
check('the umbrella itself matches', [...saved].some((entry) => matchesHostEntry('commandcode.ai', entry)), true)
check('a one-level child matches', [...saved].some((entry) => matchesHostEntry('api.commandcode.ai', entry)), true)
check('a child matches at any depth', [...saved].some((entry) => matchesHostEntry('a.b.c.d.commandcode.ai', entry)), true)
check('a hyphen sibling matches (region hosts)', [...saved].some((entry) => matchesHostEntry('eu-commandcode.ai', entry)), true)
check('an unrelated domain does not match', [...saved].some((entry) => matchesHostEntry('api.deepseek.com', entry)), false)
check('a lookalike suffix does not match', [...saved].some((entry) => matchesHostEntry('notcommandcode.ai', entry)), false)

// The three spellings of one umbrella are interchangeable.
for (const [label, set] of [['dotted', setOf('.commandcode.ai')], ['wildcard', setOf('*.commandcode.ai')]]) {
  check(`${label} spelling reaches the same child`, [...set].some((entry) => matchesHostEntry('api.commandcode.ai', entry)), true)
  check(`${label} spelling reaches deep children`, [...set].some((entry) => matchesHostEntry('x.y.commandcode.ai', entry)), true)
}

// Vertex/Azure region endpoints: the umbrella reaches the hyphen sibling.
const vertex = setOf('aiplatform.googleapis.com')
check('vertex region host via a plain umbrella', shouldForceProxy('us-central1-aiplatform.googleapis.com', vertex), true)
check('vertex bare domain matches too', shouldForceProxy('aiplatform.googleapis.com', vertex), true)

// --- 3. The force list is the only list, and it is an umbrella -------------
const forced = setOf('mirror.example')
check('the pinned umbrella itself is pinned', shouldForceProxy('mirror.example', forced), true)
check('a one-level child is pinned', shouldForceProxy('api.mirror.example', forced), true)
check('a deep child is pinned', shouldForceProxy('a.b.mirror.example', forced), true)
check('a hyphen sibling is pinned', shouldForceProxy('eu-mirror.example', forced), true)
check('an unrelated host is not pinned', shouldForceProxy('other.example', forced), false)
check('a lookalike is not pinned', shouldForceProxy('notmirror.example', forced), false)
check('an empty force list pins nothing', shouldForceProxy('api.mirror.example', new Set()), false)

// --- 4. Loopback and private networks outrank every list -------------------
for (const host of ['127.0.0.1', 'localhost', '::1', '10.1.2.3', '192.168.1.9', '172.20.0.1', '169.254.1.1', '100.64.0.1', 'fd00::1', 'fe80::1', 'nas.local']) {
  check('a private host is never pinned: ' + host, shouldForceProxy(host, setOf(host)), false)
  check('a private host is exempt: ' + host, isExemptHostname(host), true)
}
check('a public host in the same list is still pinned', shouldForceProxy('mirror.example', setOf('mirror.example', '10.0.0.1')), true)
check('a lookalike of loopback is not exempt', isExemptHostname('127.0.0.1.evil.example'), false)
check('a public host is not exempt', isExemptHostname('api.opencode.ai'), false)

// --- 5. URL validation -----------------------------------------------------
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
check('a too-small connect timeout clamps up', clamped.stability.connectTimeoutMs, STABILITY_BOUNDS.connectTimeoutMs.min)
check('a too-large response timeout clamps down', clamped.stability.responseTimeoutMs, STABILITY_BOUNDS.responseTimeoutMs.max)
check('each repair is reported', repaired.length, 2)

const options = agentOptionsOf(stock.stability)
check('the connect ceiling reaches the agent', options.connectTimeout, 60000)
check('the CONNECT tunnel shares that ceiling', options.connect.timeout, 60000)
check('TCP keepalive is on', options.connect.keepAlive, true)
check('keepalive probes start at 30s', options.connect.keepAliveInitialDelay, TCP_KEEPALIVE_DELAY_MS)
// The pooled idle window is what keeps one conversation on one tunnel: a fresh
// proxied tunnel was measured at 1.3-1.6 s, and the chat cadence is a turn every
// 10-60 s, so anything near undici's 4 s default re-dials every message.
check('a conversation keeps its tunnel', options.keepAliveTimeout, POOLED_IDLE_WINDOW_MS)
check('the pool window is long enough to span a turn', POOLED_IDLE_WINDOW_MS >= 60000, true)
check('the negotiated window cannot pull it back down', options.keepAliveMaxTimeout, POOLED_IDLE_MAX_MS)
check('the negotiated window stays at or above the idle one', options.keepAliveMaxTimeout >= options.keepAliveTimeout, true)
check('a zero stream window disables the watchdog', options.bodyTimeout, 0)
check('autoSelectFamily is on', options.connect.autoSelectFamily, true)
check('happy eyeballs uses the platform attempt window', options.connect.autoSelectFamilyAttemptTimeout, HAPPY_EYEBALLS_ATTEMPT_MS)
check('undici is not allowed to wait out a hung handshake', options.connectTimeout > 10000, true)
// One connector shape for every socket: ProxyAgent reads only proxyTls /
// requestTls, so the direct dial and the tunnel must not drift apart.
check('the tunnel and the direct dial share one connector shape', connectorOptionsOf(stock.stability), options.connect)
check('describeStability summarises the budget', describeStability(stock.stability), 'connect=60s headers=300s body=off retry=3x400ms')
check('describeStability flags safe-only retries', describeStability({ ...stock.stability, retryOnPossibleDelivery: false }), 'connect=60s headers=300s body=off retry=3x400ms retry-safe-only')

// --- 7. A Request from the platform is not the bundled undici's Request -----
// The plugin bundles its own undici, so a Request built by Node's own fetch is a
// *different class*. Passing it straight through made undici stringify it to
// "[object Request]" and reject with ERR_INVALID_URL — instantly, before any
// socket, on every attempt and on both channels. It is taken apart instead.
{
  const request = new Request('https://a.example/v1/chat', {
    method: 'POST',
    headers: { 'x-a': '1' },
    body: '{"hi":1}',
  })
  const call = await normaliseFetchCall(request, { headers: { 'x-b': '2' } })
  const headers = Object.fromEntries(call.init.headers)
  check('a foreign request becomes its URL', call.input, 'https://a.example/v1/chat')
  check('its method is carried over', call.init.method, 'POST')
  check('its body is read back out as bytes', Buffer.from(call.init.body).toString('utf8'), '{"hi":1}')
  check('both header sources survive, init last', [headers['x-a'], headers['x-b']], ['1', '2'])
}
{
  // A recording is not text: `text()` replaces every invalid UTF-8 byte with
  // U+FFFD, so the wav a speech worker received was never the wav that was sent.
  const bytes = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x80, 0x3e, 0x00, 0x00, 0xff])
  const request = new Request('https://a.example/wav', { method: 'POST', body: bytes })
  const call = await normaliseFetchCall(request)
  check('a binary body keeps every byte', [...new Uint8Array(call.init.body)], [...bytes])
}
{
  const call = await normaliseFetchCall('https://a.example/x', { headers: { 'x-a': '1' } })
  check('a string input stays a string', call.input, 'https://a.example/x')
  check('its init headers become pairs', call.init.headers, [['x-a', '1']])
}
check('headerPairs reads a record', headerPairs({ a: '1', b: 2 }), [['a', '1'], ['b', '2']])
check('headerPairs reads an array', headerPairs([['a', '1']]), [['a', '1']])
check('headerPairs reads a Headers instance', headerPairs(new Headers({ a: '1' })), [['a', '1']])
check('headerPairs has nothing for an absent list', headerPairs(undefined), undefined)

// --- 8. The shipped strategy is a remembered choice, not a set of knobs -----
// The retry budget bounds how many attempts a request gets, and the route line
// says what the attempts do: direct first with a 1 s probe, the other channel
// gets the same probe, and the channel that answers is kept.
check('describeRouting names the shipped strategy',
  describeRouting(1 + stock.stability.retryCount, 1000),
  'route=sticky (direct first with a 1000ms probe, the other channel gets the same probe, the channel that answers is kept; up to 4 attempts)')
check('describeRouting handles a single attempt',
  describeRouting(1, 1000),
  'route=sticky (direct first with a 1000ms probe, the other channel gets the same probe, the channel that answers is kept; up to 1 attempt)')

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
