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
  proxyHosts: ['commandcode.ai'],
  excludeHosts: [],
  useSystemProxy: false,
}
const config = (value) => ({
  proxy: { get: () => value.proxy },
  proxyHosts: { get: () => value.proxyHosts },
  excludeHosts: { get: () => value.excludeHosts },
  useSystemProxy: { get: () => value.useSystemProxy },
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
const empty = { proxy: '', proxyHosts: [], excludeHosts: [], useSystemProxy: false }
check('cleared settings drop the row while running', run(cleared, empty, false), KEEP)
rmSync(cleared, { recursive: true, force: true })

// --- 6. A switched-off entry with empty settings keeps its marker ---------
const offEmpty = newProfile(`${markerRow()}\n${KEEP}`, ['dsh-proxy'])
check('a disabled marker survives an empty unload', run(offEmpty, empty), `${markerRow()}\n${KEEP}`)
rmSync(offEmpty, { recursive: true, force: true })

// --- 7. An unreadable profile is never a reason to fail -------------------
const nowhere = newHost()
process.env.DSH_PROFILE_DIR = join(tmpdir(), 'dsh-proxy-unload-nowhere')
apply(nowhere.ctx, config(settings))
nowhere.unload()
check('a missing profile unloads quietly', true, true)

delete process.env.DSH_PROFILE_DIR
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
