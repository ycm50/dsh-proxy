/**
 * The subprocess export: what a child process inherits, and what the parent
 * gets back.
 *
 * The plugin reaches `pnpm` and `git` only through the environment — they read
 * it rather than this plugin's wrapped `fetch` — so the export is the whole
 * feature, and its edges carry weight:
 *
 * - a URL a Node child cannot parse must never be written (with
 *   `NODE_USE_ENV_PROXY` set, `pnpm` exits before it runs), and
 * - what the export replaced has to come back exactly, because the machine's
 *   own proxy variables are the user's, not this plugin's.
 *
 * Both are asserted against the real `apply`, on a temporary profile, with the
 * environment snapshotted around it.
 */
import { apply } from '../lib/index.js'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
/** Assert one expectation, printing the same shape the other suites use. */
function check(label, actual, expected = true) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(ok ? 'ok  ' : 'FAIL', label)
  if (!ok) console.log('      expected', JSON.stringify(expected), 'got', JSON.stringify(actual))
}

/** Every name the export may touch, in both casings. */
const NAMES = [
  'http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY',
  'no_proxy', 'NO_PROXY', 'NODE_USE_ENV_PROXY',
]
/** The current values of those names, absent ones omitted. */
const snapshot = () => Object.fromEntries(NAMES.map((n) => [n, process.env[n]]).filter(([, v]) => v !== undefined))
/** Put the environment back to a snapshot, so one case cannot leak into the next. */
function restore(to) {
  for (const name of NAMES) Reflect.deleteProperty(process.env, name)
  for (const [name, value] of Object.entries(to)) process.env[name] = value
}

/** A host context real enough for `apply`: effects collected, no services. */
function newHost() {
  const teardowns = []
  const ctx = {
    effect(fn) { const disposer = fn(); if (typeof disposer === 'function') teardowns.push(disposer); return disposer },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on() { return () => {} },
    get() { return undefined },
    inject(_deps, callback) { callback(ctx); return () => {} },
  }
  return { ctx, unload: () => { for (const disposer of teardowns.splice(0)) disposer() } }
}

/** The settings row's live fields, with the two switches stated per case. */
const config = (value) => ({
  proxy: { get: () => value.proxy },
  proxyHosts: { get: () => value.proxyHosts },
  excludeHosts: { get: () => value.excludeHosts },
  useSystemProxy: { get: () => value.useSystemProxy },
  proxySubprocesses: { get: () => value.proxySubprocesses },
})

/** A temporary profile selecting this plugin's own bundle. */
function newProfile() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-proxy-subprocess-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-proxy'] } } }), 'utf8')
  return dir
}

const base = {
  proxy: 'http://127.0.0.1:10808', proxyHosts: [], excludeHosts: [], useSystemProxy: false, proxySubprocesses: false,
}

const pristine = snapshot()

// --- 1. The switch off writes nothing --------------------------------------
const offDir = newProfile()
const offHost = newHost()
process.env.DSH_PROFILE_DIR = offDir
apply(offHost.ctx, config({ ...base }))
check('the switch off writes no proxy names', JSON.stringify(snapshot()), JSON.stringify(pristine))
offHost.unload()
rmSync(offDir, { recursive: true, force: true })

// --- 2. The switch on exports the address, in both casings -----------------
const onDir = newProfile()
const onHost = newHost()
process.env.DSH_PROFILE_DIR = onDir
apply(onHost.ctx, config({ ...base, proxySubprocesses: true }))
const exported = snapshot()
check('the address is exported', exported.HTTPS_PROXY, 'http://127.0.0.1:10808')
check('the lower-case spelling is exported too', exported.https_proxy, 'http://127.0.0.1:10808')
check('the flag makes a child read it', exported.NODE_USE_ENV_PROXY, '1')
check('loopback is bypassed for the child', exported.NO_PROXY.includes('127.0.0.1') && exported.NO_PROXY.includes('localhost') && exported.NO_PROXY.includes('[::1]'))
onHost.unload()
check('unloading the only export puts the environment back', JSON.stringify(snapshot()), JSON.stringify(pristine))
rmSync(onDir, { recursive: true, force: true })

// --- 3. Exclusions join that bypass list -----------------------------------
process.env.DSH_PROFILE_DIR = onDir
// A volatile update is the settings save path: the running instance re-reads.
const config2 = config({ ...base, proxySubprocesses: true, excludeHosts: ['internal.example'] })
const reloaded = newHost()
apply(reloaded.ctx, config2)
check('an exclusion reaches the child bypass list', snapshot().NO_PROXY.includes('internal.example'))
reloaded.unload()

// --- 4. Unload gives the environment back exactly --------------------------
// The machine's own variables are restored, not blanked: an empty proxy value
// is not the same as an absent one, and a child reads it as a proxy.
restore({ HTTPS_PROXY: 'http://corp.example:3128', no_proxy: 'corp.internal' })
const userBefore = snapshot()
const backDir = newProfile()
const backHost = newHost()
process.env.DSH_PROFILE_DIR = backDir
apply(backHost.ctx, config({ ...base, proxySubprocesses: true }))
check('the export overwrites the user value while active', snapshot().HTTPS_PROXY, 'http://127.0.0.1:10808')
backHost.unload()
check('unload restores the user value exactly', JSON.stringify(snapshot()), JSON.stringify(userBefore))
rmSync(backDir, { recursive: true, force: true })

// --- 4b. Two instances: one unload must not revoke the other's export -----
// The loader can mount a new entry before disposing the old one, and
// `process.env` is shared. The environment is derived from every live claim,
// so the surviving instance keeps its address and only the last withdrawal
// puts the machine's own values back.
restore({})
const twoA = newProfile()
const twoB = newProfile()
process.env.DSH_PROFILE_DIR = twoA
const first = newHost()
apply(first.ctx, config({ ...base, proxy: 'http://127.0.0.1:1111', proxySubprocesses: true }))
process.env.DSH_PROFILE_DIR = twoB
const second = newHost()
apply(second.ctx, config({ ...base, proxy: 'http://127.0.0.1:2222', proxySubprocesses: true }))
check('the newest claim is the one in the environment', snapshot().HTTPS_PROXY, 'http://127.0.0.1:2222')
first.unload()
check('unloading one claim leaves the other in place', snapshot().HTTPS_PROXY, 'http://127.0.0.1:2222')
second.unload()
check('the last withdrawal clears the environment', JSON.stringify(snapshot()), JSON.stringify({}))
rmSync(twoA, { recursive: true, force: true })
rmSync(twoB, { recursive: true, force: true })

// --- 5. A URL a Node child cannot parse is never written -------------------
// socks5 serves the in-process wrapper but not a child: with the flag set, a
// value Node rejects would stop pnpm from starting at all.
restore({})
const socksDir = newProfile()
const socksHost = newHost()
process.env.DSH_PROFILE_DIR = socksDir
apply(socksHost.ctx, config({ ...base, proxy: 'socks5://127.0.0.1:10808', proxySubprocesses: true }))
check('a SOCKS address is not exported', JSON.stringify(snapshot()), JSON.stringify({}))
socksHost.unload()
rmSync(socksDir, { recursive: true, force: true })

// --- 6. No address means no export, even with the switch on ----------------
restore({})
const noneDir = newProfile()
const noneHost = newHost()
process.env.DSH_PROFILE_DIR = noneDir
apply(noneHost.ctx, config({ ...base, proxy: '', proxySubprocesses: true }))
check('no address exports nothing', JSON.stringify(snapshot()), JSON.stringify({}))
noneHost.unload()
rmSync(noneDir, { recursive: true, force: true })

restore(pristine)
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
