/**
 * Node module hook for the client-half smoke test.
 *
 * Several DSH client packages are platform SEED modules: in the running app
 * the Vite shell bundles them (CSS modules inlined, browser-only dependencies
 * resolved by the shell) and publishes those instances in the static module
 * table. The published npm artifacts are the pre-bundling sources, so they
 * still import `*.module.css`, `clsx`, `shiki`, and friends — none of which
 * Node can resolve.
 *
 * The hook answers those with inert stubs and lets everything else resolve
 * normally. The parts this test exercises — `SettingsFormModel`,
 * `SettingsForm`, `SettingsValueField`, `Button`, and the card itself — are
 * real code; only styling, icon data, and markdown/highlighting are stubbed.
 */
import { readFileSync } from 'node:fs'

const PRIMITIVES = new URL(
  '../node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js',
  import.meta.url,
)

/**
 * A value that answers every property read with itself, is callable, and
 * stringifies to a stable tag — enough for the markdown/highlighting tables
 * primitives builds at module scope (`{ [codes.asterisk]: ... }`).
 */
const PROXY_VALUE = `new Proxy(function () {}, {
  get: (target, property) => property === Symbol.toPrimitive ? (() => "stub") : PROXY_VALUE,
  apply: () => PROXY_VALUE,
})`

/**
 * Build one stub module's text for a specifier by reading its import sites in
 * primitives' source, so named imports keep their bindings.
 */
function stubFor(specifier, source) {
  const defaults = new Set()
  const named = new Set()
  const pattern = /import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g
  for (const match of source.matchAll(pattern)) {
    if (match[3] !== specifier) continue
    if (match[1] !== undefined) defaults.add(match[1])
    for (const entry of (match[2] ?? '').split(',')) {
      const name = entry.trim().split(/\s+as\s+/).pop()?.trim()
      if (name !== undefined && name.length > 0) named.add(name)
    }
  }
  const lines = [`const PROXY_VALUE = ${PROXY_VALUE}`]
  for (const name of named) lines.push(`const ${name} = PROXY_VALUE`, `export { ${name} }`)
  if (named.size === 0) lines.push('export default PROXY_VALUE')
  return lines.join('\n')
}

/**
 * A stand-in for `@deepseek-ai/dsh-client-store`, also a seed module whose
 * published artifact imports zustand, immer, and zustand's own
 * `use-sync-external-store` (unreachable from this registry). The observable
 * contract below is the real one: getSnapshot / subscribe / update / set, with
 * the `raf` flush mode coalescing notifications.
 */
const STORE_STUB = `
function createSnapshotStore(init, opts) {
  let state = init
  const listeners = new Set()
  const notify = () => {
    for (const listener of [...listeners]) {
      try { listener() } catch (error) { console.error('[client-store] subscriber failed:', error) }
    }
  }
  let scheduled = false
  const schedule = typeof requestAnimationFrame === 'function'
    ? (fn) => requestAnimationFrame(() => { fn() })
    : (fn) => queueMicrotask(fn)
  const flush = () => {
    if (scheduled) return
    scheduled = true
    schedule(() => { scheduled = false; notify() })
  }
  const publish = opts && opts.flush === 'raf' ? flush : notify
  return {
    getSnapshot: () => state,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    update: (mutator) => { const draft = structuredClone(state); mutator(draft); state = draft; publish() },
    set: (next) => { state = next; publish() },
  }
}
function defineStore(decl) {
  return {
    spec: decl,
    create(scopeKey) {
      const store = createSnapshotStore(decl.init())
      const actions = {}
      for (const key of Object.keys(decl.actions)) {
        actions[key] = (...params) => { store.update((draft) => { decl.actions[key](draft, ...params) }) }
      }
      return { actions, store, getSnapshot: () => store.getSnapshot(), subscribe: (fn) => store.subscribe(fn), clearPersisted: () => {} }
    },
  }
}
const notifySubscribers = (listeners, label, ...args) => {
  for (const listener of [...listeners]) try { listener(...args) } catch (error) { console.error(label, error) }
}
const shallowEqual = (a, b) => a === b
export { createSnapshotStore, defineStore, notifySubscribers, shallowEqual }
`

const source = readFileSync(PRIMITIVES, 'utf8')
const stubCache = new Map()
const stubbed = new Set()

/** A forced stub for a specifier that WOULD resolve but must not be used. */
function forcedStub(specifier) {
  if (specifier.endsWith('.module.css')) return 'export default {}'
  if (specifier === 'clsx') return 'export default (...a) => a.filter(Boolean).join(" ")'
  if (specifier === '@deepseek-ai/dsh-client-store') return STORE_STUB
  return undefined
}

function materialize(specifier, text) {
  if (!stubCache.has(specifier)) stubCache.set(specifier, `data:text/javascript,${encodeURIComponent(text)}`)
  if (!specifier.endsWith('.module.css')) {
    stubbed.add(specifier)
    console.log(`[hook] stubbed ${specifier}`)
  }
  return { url: stubCache.get(specifier), shortCircuit: true, format: 'module' }
}

export async function resolve(specifier, context, next) {
  const forced = forcedStub(specifier)
  if (forced !== undefined) return materialize(specifier, forced)
  try {
    return await next(specifier, context)
  } catch (error) {
    const bare = !specifier.startsWith('.') && !specifier.startsWith('node:')
      && !specifier.startsWith('data:') && !specifier.startsWith('file:')
    if (!bare) throw error
    return materialize(specifier, stubFor(specifier, source))
  }
}
