/**
 * The routing wrapper's lifecycle, with more than one instance mounted.
 *
 * The loader can mount a new entry before disposing the old one, so two
 * instances of this plugin can be installed at once. Each one wraps
 * `globalThis.fetch`, and each captured the fetch it saw when it mounted — so
 * a teardown that restored its *own* capture would hand the global back to a
 * previous instance's wrapper whose dispatcher it had already closed, and
 * every later request would fail with `UND_ERR_DESTROYED`.
 *
 * These cases pin the two properties that keep that from happening: a live
 * instance keeps routing while another unloads, and the platform fetch comes
 * back only when the last wrapper goes.
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

/**
 * A host context real enough for `apply`: effects collected, subscriptions
 * recorded so a settings change can be replayed.
 */
function newHost() {
  const teardowns = []
  const subscribers = []
  const ctx = {
    effect(fn) { const disposer = fn(); if (typeof disposer === 'function') teardowns.push(disposer); return disposer },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(_event, callback) { subscribers.push(callback); return () => {} },
    get() { return undefined },
    inject(_deps, callback) { callback(ctx); return () => {} },
  }
  return {
    ctx,
    /** Announce a settings edit, the way the Loader does. */
    fire: () => { for (const callback of [...subscribers]) callback() },
    unload: () => { for (const disposer of teardowns.splice(0)) disposer() },
  }
}

/** The settings row's live fields. */
const config = (value) => ({
  proxy: { get: () => value.proxy },
  proxyHosts: { get: () => value.proxyHosts },
  excludeHosts: { get: () => value.excludeHosts },
  useSystemProxy: { get: () => value.useSystemProxy },
  proxySubprocesses: { get: () => value.proxySubprocesses },
})

/** A temporary profile selecting this plugin's own bundle. */
function newProfile() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-proxy-wrapper-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-proxy'] } } }), 'utf8')
  return dir
}

const base = {
  proxy: 'http://127.0.0.1:10808', proxyHosts: ['listed.example'], excludeHosts: [],
  useSystemProxy: false, proxySubprocesses: false,
}

const platformFetch = globalThis.fetch
const profileA = newProfile()
const profileB = newProfile()
const first = newHost()
const second = newHost()
try {
  // --- 1. A mount wraps the global ------------------------------------------
  process.env.DSH_PROFILE_DIR = profileA
  apply(first.ctx, config({ ...base }))
  const afterFirst = globalThis.fetch
  check('mounting wraps the global fetch', afterFirst !== platformFetch)

  // --- 2. A second mount wraps it again -------------------------------------
  process.env.DSH_PROFILE_DIR = profileB
  apply(second.ctx, config({ ...base, proxy: 'http://127.0.0.1:10809' }))
  check('the newest mount is the installed wrapper', globalThis.fetch !== afterFirst)

  // --- 3. The older one unloading leaves the newer one routing --------------
  first.unload()
  const afterFirstUnload = globalThis.fetch
  check('the survivor keeps its wrapper', afterFirstUnload !== platformFetch)
  check('the survivor is not the retired wrapper', afterFirstUnload !== afterFirst)

  // --- 4. The last one unloading restores the platform fetch ---------------
  second.unload()
  check('the last unload restores the platform fetch', globalThis.fetch === platformFetch)

  // --- 5. Reverse order: the newest unloads first ---------------------------
  process.env.DSH_PROFILE_DIR = profileA
  apply(first.ctx, config({ ...base }))
  const reFirst = globalThis.fetch
  process.env.DSH_PROFILE_DIR = profileB
  apply(second.ctx, config({ ...base }))
  second.unload()
  check('unloading the newest leaves the older one installed', globalThis.fetch === reFirst)
  first.unload()
  check('and the platform fetch comes back after it', globalThis.fetch === platformFetch)

  // --- 6. A settings edit reinstalls the wrapper ---------------------------
  // Reinstalling retires the old wrapper before publishing the new one. Doing
  // it the other way round would capture our *own* wrapper as the fetch this
  // module replaced, and the last teardown would then restore that dead link
  // instead of the platform fetch.
  process.env.DSH_PROFILE_DIR = profileA
  const edited = { ...base }
  apply(first.ctx, config(edited))
  const beforeEdit = globalThis.fetch
  edited.proxy = 'http://127.0.0.1:10810'
  first.fire()
  check('a settings edit reinstalls the wrapper', globalThis.fetch !== beforeEdit)
  first.unload()
  check('unloading after an edit restores the platform fetch', globalThis.fetch === platformFetch)

  // --- 7. An address that stops being usable retires the wrapper ------------
  // `refresh` drops the wrapper before judging the new address, so a value it
  // then rejects must not leave a retired wrapper installed — or a stack entry
  // that nothing will ever pop.
  process.env.DSH_PROFILE_DIR = profileA
  const toInvalid = { ...base }
  apply(first.ctx, config(toInvalid))
  check('a valid address installs a wrapper', globalThis.fetch !== platformFetch)
  toInvalid.proxy = 'notaurl'
  first.fire()
  check('an address it rejects retires the wrapper', globalThis.fetch === platformFetch)
  toInvalid.proxy = 'http://127.0.0.1:10811'
  first.fire()
  check('a usable address installs one again', globalThis.fetch !== platformFetch)
  first.unload()
  check('and unload still restores the platform fetch', globalThis.fetch === platformFetch)

  // --- 8. A wrapper that never replaced ours is not ours to undo ------------
  process.env.DSH_PROFILE_DIR = profileA
  apply(first.ctx, config({ ...base }))
  const thirdParty = (() => platformFetch)
  globalThis.fetch = thirdParty
  first.unload()
  check('a foreign fetch is left alone', globalThis.fetch === thirdParty)
} finally {
  globalThis.fetch = platformFetch
  rmSync(profileA, { recursive: true, force: true })
  rmSync(profileB, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
