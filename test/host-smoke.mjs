// Runtime smoke test for the ported host half: the volatile config contract,
// default handling, readConfig unwrapping, umbrella host matching, exclusion
// precedence, and URL validation.
import {
  Config,
  SUPPORTED_PROXY_SCHEMES,
  assertValid,
  matchesHostEntry,
  normalizeHostEntry,
  readConfig,
  shouldProxy,
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

// --- 5. The matching helper is exported for the browser half ---------------
check('matchesHostEntry is usable directly', matchesHostEntry('api.a.b', 'a.b'), true)
check('matchesHostEntry rejects a non-child', matchesHostEntry('xay.b', 'a.b'), false)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
