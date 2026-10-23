// Unload-cleanup test for the host half: what `apply` does to the profile when
// its fiber goes away. DSH tears a fiber down the same way for a restart, an
// HMR reload, an update, and a switch-off, so the policy reads DSH's own
// persistent state — the profile's selected bundles and the row's own
// `disabled` key — instead of guessing from the unload alone.
//
// The context below is the smallest thing `apply` accepts: the point is the
// file it rewrites, not Cordis.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

let failures = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` -- got ${a}, want ${e}`}`)
}

const PATCH_FILE = 'cordis.patch.yml'

/** The neighbouring row the cleanup must leave byte-for-byte alone. */
const KEEP = ['- id: keep', '  name: keep', ''].join('\n')

/** This plugin's settings row, with the optional DSH `disabled` marker. */
function settingsRow(disabled) {
  return [
    '- id: dsh-proxy',
    '  name: dsh-proxy',
    ...(disabled ? ['  disabled: true'] : []),
    '  config:',
    '    proxy: http://127.0.0.1:10808',
    '    proxyHosts:',
    '      - commandcode.ai',
  ].join('\n')
}

/** The row after only its settings were taken out. */
function markerRow() {
  return ['- id: dsh-proxy', '  name: dsh-proxy', '  disabled: true'].join('\n')
}

/** A temporary profile directory: patch always, manifest when asked. */
function newProfile(patch, bundles) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-proxy-unload-'))
  writeFileSync(join(dir, PATCH_FILE), patch, 'utf8')
  if (bundles !== undefined) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles } } }, null, 2), 'utf8')
  }
  return dir
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

/** A config carrying the settings row's values. */
const settings = {
  proxy: 'http://127.0.0.1:10808',
  forceHosts: ['commandcode.ai'],
  useSystemProxy: false,
  proxySubprocesses: false,
}
const config = (value) => ({
  proxy: { get: () => value.proxy },
  useSystemProxy: { get: () => value.useSystemProxy },
  proxySubprocesses: { get: () => value.proxySubprocesses },
  // Stability refs, present for the same reason the Loader always supplies
  // them: the request path reads every one of them on each refresh.
  connectTimeoutMs: { get: () => value.connectTimeoutMs ?? 60000 },
  responseTimeoutMs: { get: () => value.responseTimeoutMs ?? 300000 },
  streamIdleTimeoutMs: { get: () => value.streamIdleTimeoutMs ?? 0 },
  retryCount: { get: () => value.retryCount ?? 3 },
  retryDelayMs: { get: () => value.retryDelayMs ?? 400 },
  retryOnPossibleDelivery: { get: () => value.retryOnPossibleDelivery ?? true },
})

/** Load the plugin against one temporary profile and report the file after. */
function run(dir, value, unload = true) {
  process.env.DSH_PROFILE_DIR = dir
  const host = newHost()
  apply(host.ctx, config(value))
  if (unload) host.unload()
  return readFileSync(join(dir, PATCH_FILE), 'utf8')
}

// --- 1. Switched off by deselecting the bundle: the row goes entirely ------
const deselected = newProfile(`${settingsRow(false)}\n${KEEP}`, ['dsh-base', 'dsh-web-app'])
check('deselected bundle removes the row', run(deselected, settings), KEEP)
rmSync(deselected, { recursive: true, force: true })

// A disabled row whose bundle is gone too is pure residue: the entry is not
// composed, so the whole row goes (the marker has nothing left to hold off).
const deselectedDisabled = newProfile(`${settingsRow(true)}\n${KEEP}`, ['dsh-base'])
check('a deselected bundle takes a disabled row with it', run(deselectedDisabled, settings), KEEP)
rmSync(deselectedDisabled, { recursive: true, force: true })

// --- 2. Uninstalled is the same signal ------------------------------------
const uninstalled = newProfile(`${settingsRow(false)}\n${KEEP}`, [])
check('uninstall removes the row', run(uninstalled, settings), KEEP)
rmSync(uninstalled, { recursive: true, force: true })

// --- 3. Switched off through the row's own `disabled` key: the settings go,
// ---    the marker stays. Deleting it would re-enable the entry the bundle
// ---    inserts, so this is the furthest a cleanup may go ------------------
const switched = newProfile(`${settingsRow(true)}\n${KEEP}`, ['dsh-proxy'])
check('a disabled row keeps its marker', run(switched, settings), `${markerRow()}\n${KEEP}`)
rmSync(switched, { recursive: true, force: true })

// --- 4. A plain reload must not cost the user their settings --------------
const reloaded = newProfile(`${settingsRow(false)}\n${KEEP}`, ['dsh-proxy'])
check('a reload leaves the row alone', run(reloaded, settings), `${settingsRow(false)}\n${KEEP}`)
rmSync(reloaded, { recursive: true, force: true })

// --- 5. Clearing the settings while running still empties the row ---------
const cleared = newProfile(`${settingsRow(false)}\n${KEEP}`, ['dsh-proxy'])
const empty = {
  proxy: '', forceHosts: [], useSystemProxy: false,
  proxySubprocesses: false,
}
check('cleared settings drop the row while running', run(cleared, empty, false), KEEP)
rmSync(cleared, { recursive: true, force: true })

// --- 6. A switched-off entry with empty settings keeps its marker ---------
const offEmpty = newProfile(`${markerRow()}\n${KEEP}`, ['dsh-proxy'])
check('a disabled marker survives an empty unload', run(offEmpty, empty), `${markerRow()}\n${KEEP}`)
rmSync(offEmpty, { recursive: true, force: true })

// --- 6b. A switch that is its own information keeps the row ----------------
const subprocessOnly = { ...empty, proxySubprocesses: true }
const subRow = newProfile(`${settingsRow(false)}\n${KEEP}`, ['dsh-proxy'])
check('subprocess switch alone keeps the row', run(subRow, subprocessOnly), `${settingsRow(false)}\n${KEEP}`)
rmSync(subRow, { recursive: true, force: true })

// The inverse: with the switch at its default, the row is still vacant and
// still goes — the new field must not make every row permanent.
const bothOff = newProfile(`${settingsRow(false)}\n${KEEP}`, ['dsh-proxy'])
check('the switch off is still vacant', run(bothOff, empty, false), KEEP)
rmSync(bothOff, { recursive: true, force: true })

// A switch turned on while the plugin runs must also survive that unload,
// which is the path a settings save takes.
const onWhileRunning = newProfile(`${settingsRow(false)}\n${KEEP}`, ['dsh-proxy'])
check('a switch turned on while running survives the unload', run(onWhileRunning, subprocessOnly), `${settingsRow(false)}\n${KEEP}`)
rmSync(onWhileRunning, { recursive: true, force: true })

// --- 7. An unreadable profile is never a reason to fail -------------------
const nowhere = newHost()
process.env.DSH_PROFILE_DIR = join(tmpdir(), 'dsh-proxy-unload-nowhere')
apply(nowhere.ctx, config(settings))
nowhere.unload()
check('a missing profile unloads quietly', true, true)

// --- 8. Observation is opt-in, and belongs to the fiber -------------------
// The observer holds a process-wide diagnostics subscription, so the only two
// things worth asserting here are that it is off unless asked for, and that a
// mount which has it on still mounts (and unloads) like any other.
// The host keeps what the plugin logged, so the wiring is visible from outside.
function newHostWithLog() {
  const lines = []
  const teardowns = []
  const ctx = {
    effect(fn) { const disposer = fn(); if (typeof disposer === 'function') teardowns.push(disposer); return disposer },
    logger: { info: (...args) => lines.push(args.join(' ')), warn: (...args) => lines.push(args.join(' ')), error() {}, debug() {} },
    on() { return () => {} },
    get() { return undefined },
    inject(_deps, callback) { callback(ctx); return () => {} },
  }
  return { ctx, lines, unload: () => { for (const disposer of teardowns.splice(0)) disposer() } }
}

const observing = newProfile(`${settingsRow(false)}\n${KEEP}`, ['dsh-proxy'])
process.env.DSH_PROFILE_DIR = observing

delete process.env.DSH_PROXY_DEBUG
const quietHost = newHostWithLog()
apply(quietHost.ctx, config(settings))
check('observation stays off without the flag', quietHost.lines.some((line) => line.includes('request observation')), false)
check('the flag off still routes', quietHost.lines.some((line) => line.includes('routing installed')), true)
quietHost.unload()

process.env.DSH_PROXY_DEBUG = '1'
const loudHost = newHostWithLog()
apply(loudHost.ctx, config(settings))
check('DSH_PROXY_DEBUG turns observation on', loudHost.lines.some((line) => line.includes('request observation is on')), true)
check('observation does not replace routing', loudHost.lines.some((line) => line.includes('routing installed')), true)
loudHost.unload()
delete process.env.DSH_PROXY_DEBUG
rmSync(observing, { recursive: true, force: true })

delete process.env.DSH_PROFILE_DIR
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
