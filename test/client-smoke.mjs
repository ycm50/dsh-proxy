// Client-half smoke test: materialize the built bundle the way the DSH module
// loader does, run apply() against a stubbed boot context, and render the
// settings page through the REAL primitives' SettingsForm/SettingsValueField
// to server HTML.
//
// This is the check that matters most for the port: the bundle only requires
// platform seed words, the plugin injects the services 0.1.7 actually provides,
// it registers into the `settings.section` slot the settings shell projects
// into its left-hand navigation, and the page's prop shape matches what that
// shell renders.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` -- ${detail}`}`)
}

// --- 1. Register the bundle exactly as a script tag would --------------------
// The published primitives artifact runs a little browser setup at module
// scope, so the test needs the globals a browser would have. Nothing here
// stands in for React rendering: that is react-dom/server's real job. The
// bundle's own CSS-module stylesheet is injected through `document`, so the
// stub records the tags it is handed.
const noop = () => {}
const styleTags = []
const element = () => ({
  style: {}, dataset: {}, className: '', textContent: '', textContent_amp: '',
  appendChild: noop, setAttribute: noop, addEventListener: noop, removeEventListener: noop,
})
const windowStub = {
  addEventListener: noop,
  removeEventListener: noop,
  dispatchEvent: () => true,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: noop,
  matchMedia: () => ({
    matches: false, media: '', addEventListener: noop, removeEventListener: noop,
    addListener: noop, removeListener: noop,
  }),
  location: { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1', protocol: 'http:' },
  navigator: { userAgent: 'node', language: 'en', languages: ['en'] },
  document: {
    createElement: (tag) => { const node = element(); if (tag === 'style') styleTags.push(node); return node },
    querySelector: () => null,
    addEventListener: noop,
    removeEventListener: noop,
    head: { appendChild: noop },
    body: { appendChild: noop },
  },
}
globalThis.window = windowStub
globalThis.document = windowStub.document
// Node 24 exposes a read-only `navigator`; reuse it and fill in only the
// members a browser would have.
try {
  Object.defineProperty(globalThis, 'navigator', { value: windowStub.navigator, configurable: true })
} catch {
  for (const [key, value] of Object.entries(windowStub.navigator)) {
    if (globalThis.navigator[key] !== undefined) continue
    try { Object.defineProperty(globalThis.navigator, key, { value, configurable: true }) } catch { /* read-only global */ }
  }
}
globalThis.requestAnimationFrame = windowStub.requestAnimationFrame
globalThis.cancelAnimationFrame = noop

let registration
windowStub.__ModuleLoader__ = { load(reg) { registration = reg } }
await import('../lib/client.js')
check('bundle registers itself under its package id', registration?.id === 'dsh-proxy', String(registration?.id))
check('bundle exposes a factory', typeof registration?.factory === 'function')

// The seed module table the shell installs before any bundle runs.
const seed = {
  react: await import('react'),
  'react/jsx-runtime': await import('react/jsx-runtime'),
  '@deepseek-ai/dsh-client-ui-primitives': await import('@deepseek-ai/dsh-client-ui-primitives'),
}
const required = []
const exports_ = registration.factory((spec) => {
  required.push(spec)
  if (!(spec in seed)) throw new Error(`require("${spec}") missed the module table`)
  return seed[spec]
})
check('materializing the bundle only asks for seed words', required.every(s => s in seed), required.join(', '))
check('bundle exports apply()', typeof exports_.apply === 'function')
check('bundle injects the 0.1.7 services', JSON.stringify(exports_.inject) === JSON.stringify(['slots', 'locale', 'configForms']), JSON.stringify(exports_.inject))
check('bundle ships its own stylesheet', styleTags.length > 0, String(styleTags.length))
check('the stylesheet is plugin-owned', styleTags.every(tag => tag.dataset.plugin === 'dsh-proxy'))

// --- 2. Run apply() against a stubbed browser context -----------------------
const registrations = []
const injectedSlots = []
let servedNamespaces
let boundNamespace
let registeredDictionaries

const snapshot = {
  status: 'ready',
  value: { proxy: 'socks5://127.0.0.1:7890', proxyHosts: ['gateway.acme.example'], excludeHosts: [] },
  base: {},
  user: { proxy: 'socks5://127.0.0.1:7890' },
  revision: 1,
  writable: true,
  mode: 'host',
}
const scope = {
  getSnapshot: () => snapshot,
  subscribe: () => () => {},
  mutate: async () => true,
}
const mirror = {
  getSnapshot: () => ({ status: 'ready', view: { namespaces: [], writable: true, hasDocument: true }, error: null }),
  subscribe: () => () => {},
  ensure: async () => {},
  acceptView: () => {},
}
// The Host half is reached through the browser `connection` service's generic
// RPC caller, so the stub records what the page asks and answers like this
// plugin's own Host half would.
const rpcCalls = []
const connection = {
  rpc: {
    async call(channel, endpoint, payload) {
      rpcCalls.push({ channel, endpoint, payload })
      return {
        ok: true,
        value: {
          proxy: 'http://127.0.0.1:10808',
          source: 'windows-registry',
          detail: 'Windows Internet Settings: 127.0.0.1:10808',
          platform: 'win32',
        },
      }
    },
  },
}

const ctx = {
  effect(fn) { fn(); return () => {} },
  get(name) { return name === 'connection' ? connection : undefined },
  locale: {
    bind(ns) { boundNamespace = ns; return (key) => `«${key}»` },
    register(ns, dicts) { registeredDictionaries = { ns, dicts }; return () => {} },
  },
  configForms: {
    get(entryId) { scope.entryId = entryId; return scope },
    describe: () => mirror,
    whileServed(namespaces, register) { servedNamespaces = namespaces; return register(new Set(namespaces)) },
  },
  slots: {
    inject(key, callback) { injectedSlots.push(key); return callback() },
    register(options, component) { registrations.push({ options, component }); return () => {} },
  },
}

exports_.apply(ctx)

check('binds the dictionary namespace', boundNamespace === 'settings.httpProxy', String(boundNamespace))
check('registers both dictionaries', registeredDictionaries?.ns === 'settings.httpProxy'
  && typeof registeredDictionaries.dicts.zh === 'object' && typeof registeredDictionaries.dicts.en === 'object')
check('opens the config form on the Host entry id', scope.entryId === 'dsh-proxy', String(scope.entryId))
check('watches the served namespace', JSON.stringify(servedNamespaces) === JSON.stringify(['dsh-proxy']), JSON.stringify(servedNamespaces))
check('waits on the settings.section slot', JSON.stringify(injectedSlots) === JSON.stringify(['settings.section']), JSON.stringify(injectedSlots))

const entry = registrations[0]
check('registers exactly one navigation row', registrations.length === 1, String(registrations.length))
check('registration targets settings.section', entry?.options.name === 'settings.section')
check('section key matches the Host entry id', entry?.options.id === 'dsh-proxy')
check('section carries a nav position after the built-ins', typeof entry?.options.order === 'number' && entry.options.order > 15, String(entry?.options.order))
check('section carries a label thunk', typeof entry?.options.label === 'function' && entry.options.label() === '«title»')
check('section declares its locale namespace', entry?.options.locale === 'settings.httpProxy')

// --- 3. Render the page through the real primitives -------------------------
const face = entry.options.inject()
check('face exposes the form hook', typeof face.hooks?.httpProxyForm?.getSnapshot === 'function')
check('face exposes the shared form actions',
  ['edit', 'resetField', 'save', 'discard'].every(name => typeof face[name] === 'function'))

const hookProps = Object.fromEntries(
  Object.entries(face.hooks).map(([name, store]) => [
    `use${name[0].toUpperCase()}${name.slice(1)}`,
    (selector) => selector(store.getSnapshot()),
  ]),
)
const page = renderToStaticMarkup(createElement(entry.component, {
  // The settings shell's owner share: the page may close the panel.
  close: noop,
  ...hookProps,
  edit: face.edit,
  resetField: face.resetField,
  save: face.save,
  discard: face.discard,
  t: (key) => `«${key}»`,
}))

check('page renders its own heading', page.includes('dsh-proxy-heading') && page.includes('«title»'), page.slice(0, 160))
check('page renders the one-line intro', page.includes('«description»'))
check('page renders the form frame', page.includes('«save»'))
check('page renders the proxy control with its stored value', page.includes('socks5://127.0.0.1:7890'))
check('page renders the proxy label', page.includes('«proxy»'))
check('page renders both host fields', page.includes('dsh-proxy-hosts') && page.includes('dsh-proxy-exclude'))
check('page renders the stored host list as text', page.includes('gateway.acme.example'))
check('page offers the known-host pick list', page.includes('«suggestions»'))
check('page marks the saved proxy overridden', page.includes('«overridden»'))
check('page renders four inputs', (page.match(/<input/g) ?? []).length === 4, String((page.match(/<input/g) ?? []).length))
check('page renders the system-proxy switch', page.includes('type="checkbox"') && page.includes('«useSystemProxy»'))

// The switch's reading is a round trip to this plugin's own Host channel: the
// page asks for it, and fills the address field from the answer.
const read = await face.readSystemProxy()
check('reads the system proxy on the shared browser carrier',
  rpcCalls[0]?.channel === '/api' && rpcCalls[0]?.endpoint === 'dsh-proxy/system-proxy', JSON.stringify(rpcCalls[0]))
check('passes the Host reading through', read.status === 'ok' && read.reading.proxy === 'http://127.0.0.1:10808'
  && read.reading.source === 'windows-registry', JSON.stringify(read))
const withoutConnection = connection.rpc
connection.rpc = undefined
const unavailable = await face.readSystemProxy()
connection.rpc = withoutConnection
check('a deployment without Connection reports unavailable', unavailable.status === 'unavailable', JSON.stringify(unavailable))
if (process.env.SMOKE_HTML) console.log(`\n--- rendered page ---\n${page.replace(/></g, '>\n<')}\n--- end ---\n`)

// The host field's text must round-trip through the shared form model, and a
// pristine page must offer no write.
check('host field text round-trips', face.hooks.httpProxyForm.getSnapshot().proxyHosts.text === 'gateway.acme.example')
check('an untouched page has nothing to save', face.hooks.httpProxyForm.getSnapshot().dirty === false)
check('an untouched page is not marked invalid', face.hooks.httpProxyForm.getSnapshot().invalid === false)

// --- 4. An unserved namespace still reports as unavailable -----------------
check('unavailable snapshots are what the frame reports', ({ ...snapshot, status: 'unavailable' }).status === 'unavailable')

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
