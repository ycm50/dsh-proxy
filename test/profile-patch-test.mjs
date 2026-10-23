// Self-cleanup test for the profile patch layer: the row that DSH writes for
// this plugin must come back out when the settings carry nothing, without
// touching any other entry, comment, or `!!js` expression. Rows written by
// pre-0.3 releases (`id: http-proxy`, `name: dsh-http-proxy`) are residue too
// and must go as well.
//
// Imports only `lib/profile-patch.js`, so it needs none of the host half's
// runtime dependencies.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROFILE_MANIFEST_FILE,
  PROFILE_PATCH_FILE,
  PROXY_ENTRY_ID,
  PROXY_IDENTITIES,
  PROXY_PACKAGE_NAME,
  planRowCleanup,
  profileManifestPath,
  profilePatchPath,
  pruneProxyEntry,
  pruneProxyEntryFromProfile,
  readBundleSelection,
  readProxyEntryState,
  stripProxyEntryConfig,
  stripProxyEntryConfigFromProfile,
} from '../lib/profile-patch.js'

let failures = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` -- got ${a}, want ${e}`}`)
}

/** A realistic profile patch: our row between two unrelated entries. */
const PATCH = [
  '# Your patch layer for this dsh profile',
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  '  config:',
  '    provider: commandcode',
  '- id: dsh-proxy',
  '  name: dsh-proxy',
  '  config:',
  '    proxy: http://127.0.0.1:10808',
  '    proxyHosts:',
  '      - commandcode.ai',
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  "    baseURL: '!!js process.env.GATEWAY'",
  '',
].join('\n')

const CLEAN = [
  '# Your patch layer for this dsh profile',
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  '  config:',
  '    provider: commandcode',
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  "    baseURL: '!!js process.env.GATEWAY'",
  '',
].join('\n')

// --- 1. The row goes, everything else stays verbatim ------------------------
const pruned = pruneProxyEntry(PATCH)
check('changed', pruned.changed, true)
check('reason', pruned.reason, 'removed')
check('removed identity reported', pruned.id, 'dsh-proxy')
check('row removed, neighbours intact', pruned.text, CLEAN)
check('comment kept', pruned.text.includes('# Your patch layer'), true)
check('!!js expression kept', pruned.text.includes("'!!js process.env.GATEWAY'"), true)

// --- 2. Idempotent, and identity when there is nothing to remove ------------
const twice = pruneProxyEntry(pruned.text)
check('second pass unchanged', twice.text, CLEAN)
check('second pass not changed', twice.changed, false)
check('second pass reason', twice.reason, 'absent')

// --- 3. A pre-0.3 row is the same plugin's residue -------------------------
const LEGACY = [
  '- id: keep',
  '  name: keep',
  '- id: http-proxy',
  '  name: dsh-http-proxy',
  '  config:',
  '    proxy: http://127.0.0.1:10808',
  '',
].join('\n')
const legacy = pruneProxyEntry(LEGACY)
check('legacy row removed', legacy.text, '- id: keep\n  name: keep\n')
check('legacy identity reported', legacy.id, 'http-proxy')

// --- 4. A row that names another package under the same id is never touched -
const foreign = ['- id: dsh-proxy', '  name: someone-elses-proxy', '  config: {}', ''].join('\n')
check('foreign name survives', pruneProxyEntry(foreign).text, foreign)
check('foreign name not changed', pruneProxyEntry(foreign).changed, false)

// A row with no `name:` at all is still ours (the entry id is the plugin name).
const nameless = ['- id: dsh-proxy', '  config: {}', ''].join('\n')
check('nameless row removed', pruneProxyEntry(nameless).text, '[]\n')

// A patch that ends up with no entries at all becomes the empty entry list.
const onlyComments = ['# keep me', '- id: dsh-proxy', '  config: {}', ''].join('\n')
check('comments-only leftovers stay comments-only', pruneProxyEntry(onlyComments).text, '# keep me\n')

// --- 5. A row nested in `insert:` takes an emptied list with it -------------
const nested = [
  '- insert:',
  '    - id: dsh-proxy',
  "      name: 'dsh-proxy'",
  '- id: other',
  '  name: other',
  '',
].join('\n')
const nestedClean = ['- id: other', '  name: other', ''].join('\n')
check('nested row and emptied insert removed', pruneProxyEntry(nested).text, nestedClean)

// ...but the parent stays while a sibling remains.
const nestedSibling = [
  '- insert:',
  '    - id: dsh-proxy',
  "      name: 'dsh-proxy'",
  '    - id: kept',
  '      name: kept',
  '',
].join('\n')
const nestedSiblingClean = ['- insert:', '    - id: kept', '      name: kept', ''].join('\n')
check('sibling keeps the insert list', pruneProxyEntry(nestedSibling).text, nestedSiblingClean)

// --- 6. CRLF patches keep their EOL, trailing newline or not ---------------
const crlf = PATCH.replace(/\n/g, '\r\n')
check('CRLF preserved', pruneProxyEntry(crlf).text, CLEAN.replace(/\n/g, '\r\n'))
const noTrailing = PATCH.slice(0, -1)
check('no trailing newline preserved', pruneProxyEntry(noTrailing).text, CLEAN.slice(0, -1))

// --- 7. Profile path resolution --------------------------------------------
check(
  'DSH_PROFILE_DIR wins',
  profilePatchPath({ DSH_PROFILE_DIR: 'C:\\p', DSH_HOME: 'C:\\h', DSH_PROFILE: 'web' }),
  join('C:\\p', PROFILE_PATCH_FILE),
)
check(
  'DSH_HOME + DSH_PROFILE',
  profilePatchPath({ DSH_HOME: 'C:\\h', DSH_PROFILE: 'web' }),
  join('C:\\h', 'profiles', 'web', PROFILE_PATCH_FILE),
)
check('desktop default', profilePatchPath({ DSH_HOME: 'C:\\h' }).endsWith(join('profiles', 'desktop', PROFILE_PATCH_FILE)), true)

// --- 8. End to end on disk -------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'dsh-proxy-patch-'))
try {
  const file = join(dir, PROFILE_PATCH_FILE)
  const env = { DSH_PROFILE_DIR: dir }
  writeFileSync(file, PATCH, 'utf8')

  const outcome = pruneProxyEntryFromProfile(env)
  check('cleanup reports the file', outcome.file, file)
  check('cleanup removed', outcome.removed, true)
  check('cleanup reason', outcome.reason, 'removed')
  check('cleanup identity', outcome.id, 'dsh-proxy')
  check('file rewritten', readFileSync(file, 'utf8'), CLEAN)

  const again = pruneProxyEntryFromProfile(env)
  check('second cleanup removed nothing', again.removed, false)
  check('second cleanup reason', again.reason, 'no-row')

  // A legacy row is cleaned by the same pass.
  writeFileSync(file, LEGACY, 'utf8')
  const legacyOutcome = pruneProxyEntryFromProfile(env)
  check('legacy cleanup removed', legacyOutcome.removed, true)
  check('legacy cleanup identity', legacyOutcome.id, 'http-proxy')

  const missing = pruneProxyEntryFromProfile({ DSH_PROFILE_DIR: join(dir, 'nowhere') })
  check('missing patch reports', missing.reason, 'no-patch-file')

  // No staging file may be left behind next to the patch.
  const leftovers = readFileSync(file, 'utf8').includes('.prune.tmp')
  check('no staging residue', leftovers, false)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// --- 9. The identity contract the patch rows are matched against ------------
check('entry id', PROXY_ENTRY_ID, 'dsh-proxy')
check('package name', PROXY_PACKAGE_NAME, 'dsh-proxy')
check(
  'legacy identity is still recognised',
  PROXY_IDENTITIES.some((i) => i.id === 'http-proxy' && i.name === 'dsh-http-proxy'),
  true,
)


// --- 10. Reading the switch-off signals the unload policy acts on ----------
// DSH writes \`disabled: true\` into the row to switch one entry off, and drops
// the bundle from \`dsh.profile.bundles\` to switch a bundle off; an unload alone
// means nothing, because a reload tears the fiber down the same way.
check('a plain row reads as enabled', readProxyEntryState(PATCH), 'enabled')
check('a missing row reads as absent', readProxyEntryState('- id: keep\n  name: keep\n'), 'absent')
check(
  'a foreign row under our id is not ours',
  readProxyEntryState('- id: dsh-proxy\n  name: someone-elses-proxy\n  disabled: true\n'),
  'absent',
)
const DISABLED_ROW = [
  '- id: dsh-proxy',
  '  name: dsh-proxy',
  '  disabled: true',
  '  config:',
  '    proxy: http://127.0.0.1:10808',
  '',
].join('\n')
check('a disabled row reads as disabled', readProxyEntryState(DISABLED_ROW), 'disabled')
check('disabled: false is not disabled', readProxyEntryState(DISABLED_ROW.replace('true', 'false')), 'enabled')

// --- 11. Taking the settings out while keeping the marker ------------------
// The row keeps its `disabled` marker; the config block, and only it, goes.
const DISABLED_NEIGHBOURED = [
  '# Your patch layer for this dsh profile',
  '- id: dsh-proxy',
  '  name: dsh-proxy',
  '  disabled: true',
  '  config:',
  '    proxy: http://127.0.0.1:10808',
  '    proxyHosts:',
  '      - commandcode.ai',
  '- id: keep',
  '  name: keep',
  '',
].join('\n')
const strippedText = [
  '# Your patch layer for this dsh profile',
  '- id: dsh-proxy',
  '  name: dsh-proxy',
  '  disabled: true',
  '- id: keep',
  '  name: keep',
  '',
].join('\n')
const stripped = stripProxyEntryConfig(DISABLED_NEIGHBOURED)
check('config dropped', stripped.changed, true)
check('strip reason', stripped.reason, 'stripped')
check('marker and neighbours survive', stripped.text, strippedText)
check('strip is idempotent', stripProxyEntryConfig(stripped.text).changed, false)
check('strip reports no-config', stripProxyEntryConfig(stripped.text).reason, 'no-config')
check('strip leaves a foreign row alone', stripProxyEntryConfig('- id: dsh-proxy\n  name: other\n  config: {}\n').changed, false)
check('strip reports an absent row', stripProxyEntryConfig('- id: keep\n  name: keep\n').reason, 'absent')

// --- 12. The bundle selection, and the cleanup plan it feeds ---------------
const planDir = mkdtempSync(join(tmpdir(), 'dsh-proxy-plan-'))
try {
  writeFileSync(join(planDir, PROFILE_PATCH_FILE), DISABLED_ROW, 'utf8')
  const env = { DSH_PROFILE_DIR: planDir }
  check('manifest path', profileManifestPath(env), join(planDir, PROFILE_MANIFEST_FILE))
  check('no manifest is unknown', readBundleSelection(env), 'unknown')
  writeFileSync(join(planDir, PROFILE_MANIFEST_FILE), JSON.stringify({ dsh: { profile: { bundles: ['dsh-base'] } } }), 'utf8')
  check('a manifest without our bundle is deselected', readBundleSelection(env), 'deselected')
  check('a deselected bundle removes the row', planRowCleanup(false, env), {
    mode: 'remove',
    reason: 'the profile no longer selects this plugin bundle',
  })
  writeFileSync(join(planDir, PROFILE_MANIFEST_FILE), JSON.stringify({ dsh: { profile: { bundles: ['dsh-proxy'] } } }), 'utf8')
  check('a selected bundle keeps the settings', readBundleSelection(env), 'selected')
  check('a disabled row strips the settings', planRowCleanup(false, env), {
    mode: 'strip-config',
    reason: 'the profile switches this plugin entry off',
  })
  writeFileSync(join(planDir, PROFILE_PATCH_FILE), PATCH, 'utf8')
  check('an enabled row with settings is left alone', planRowCleanup(false, env), undefined)
  check('an enabled row with empty settings is removed', planRowCleanup(true, env), {
    mode: 'remove',
    reason: 'unloaded with empty settings',
  })

  // ...and the strip the plan asks for lands on disk.
  writeFileSync(join(planDir, PROFILE_PATCH_FILE), DISABLED_ROW, 'utf8')
  const stripOutcome = stripProxyEntryConfigFromProfile(env)
  check('strip reports the file', stripOutcome.file, join(planDir, PROFILE_PATCH_FILE))
  check('strip reports what it did', stripOutcome.reason, 'stripped')
  check('strip wrote the marker-only row', readFileSync(join(planDir, PROFILE_PATCH_FILE), 'utf8'), '- id: dsh-proxy\n  name: dsh-proxy\n  disabled: true\n')
  check('second strip changes nothing', stripProxyEntryConfigFromProfile(env).removed, false)
  check('a missing patch reports', stripProxyEntryConfigFromProfile({ DSH_PROFILE_DIR: join(planDir, 'nowhere') }).reason, 'no-patch-file')
} finally {
  rmSync(planDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
