// Offline test for the system-proxy reading: the Windows registry values, the
// per-target ProxyServer forms, macOS scutil, GSettings quoting, the
// environment fallback, and the platform chain. The probes themselves belong to
// the machine, not to this plugin, so every check feeds the parsers output
// instead of running one.
import {
  normalizeProxyValue,
  parseGsettingsValue,
  parseScutilProxy,
  parseWindowsProxyServer,
  parseWindowsRegistry,
  pickWindowsProxy,
  readEnvironmentProxy,
  readSystemProxy,
} from '../lib/index.js'

let failures = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` -- got ${a}, want ${e}`}`)
}

// --- 1. One value, normalized ---------------------------------------------
check('a bare host:port reads as HTTP', normalizeProxyValue('127.0.0.1:10808'), 'http://127.0.0.1:10808')
check('a supported scheme is kept', normalizeProxyValue('socks5://127.0.0.1:10808'), 'socks5://127.0.0.1:10808')
check('a scheme is lower-cased', normalizeProxyValue('HTTP://127.0.0.1:8080'), 'http://127.0.0.1:8080')
check('credentials survive', normalizeProxyValue('http://user:pw@10.0.0.1:3128'), 'http://user:pw@10.0.0.1:3128')
check('a path is dropped', normalizeProxyValue('http://127.0.0.1:8080/proxy.pac'), 'http://127.0.0.1:8080')
check('empty reads as nothing', normalizeProxyValue('   '), undefined)
check('an unsupported scheme reads as nothing', normalizeProxyValue('ftp://127.0.0.1:21'), undefined)
check('a scheme with no host reads as nothing', normalizeProxyValue('http://'), undefined)

// --- 2. Windows' ProxyServer value ----------------------------------------
check(
  'one shared entry',
  parseWindowsProxyServer('127.0.0.1:10808'),
  [{ url: 'http://127.0.0.1:10808' }],
)
const perTarget = parseWindowsProxyServer('http=127.0.0.1:10809;https=127.0.0.1:10808')
check('one entry per target', perTarget, [
  { target: 'http', url: 'http://127.0.0.1:10809' },
  { target: 'https', url: 'http://127.0.0.1:10808' },
])
check('https is preferred for the HTTPS requests this plugin routes', pickWindowsProxy(perTarget), {
  target: 'https',
  url: 'http://127.0.0.1:10808',
})
check('a shared entry covers everything', pickWindowsProxy(parseWindowsProxyServer('10.0.0.1:3128')), {
  url: 'http://10.0.0.1:3128',
})
check(
  'a socks target becomes a SOCKS URL',
  parseWindowsProxyServer('socks=127.0.0.1:1080'),
  [{ target: 'socks', url: 'socks5://127.0.0.1:1080' }],
)
check('an unusable entry is skipped', parseWindowsProxyServer(';ftp://127.0.0.1:21;'), [])

// --- 3. reg query output ---------------------------------------------------
const registryOutput = [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
  '    ProxyEnable    REG_DWORD    0x1',
  '    ProxyServer    REG_SZ    127.0.0.1:10808',
  '    ProxyOverride    REG_SZ    <local>',
  '    AutoConfigURL    REG_SZ    http://127.0.0.1:10809/pac',
  '',
].join('\r\n')
const registry = parseWindowsRegistry(registryOutput)
check('ProxyEnable is read', registry.enable, true)
check('ProxyServer is read', registry.server, '127.0.0.1:10808')
check('AutoConfigURL is read', registry.pacUrl, 'http://127.0.0.1:10809/pac')
check('AutoDetect rests at false', registry.autoDetect, false)
const disabled = parseWindowsRegistry('    ProxyEnable    REG_DWORD    0x0\r\n    ProxyServer    REG_SZ    127.0.0.1:10808\r\n')
check('a switched-off proxy is off', disabled.enable, false)

// --- 4. macOS scutil and Linux GSettings ----------------------------------
const scutil = [
  '<dictionary> {',
  '  HTTPEnable : 0',
  '  HTTPSEnable : 1',
  '  HTTPSProxy : 127.0.0.1',
  '  HTTPSPort : 10808',
  '  SOCKSEnable : 0',
  '}',
].join('\n')
check('scutil prefers the enabled HTTPS entry', parseScutilProxy(scutil).proxy, 'http://127.0.0.1:10808')
check(
  'scutil reports a PAC script',
  parseScutilProxy('ProxyAutoConfigEnable : 1\nProxyAutoConfigURLString : http://wpad/p.pac\n'),
  { proxy: '', detail: 'macOS uses the auto-config script http://wpad/p.pac', pacUrl: 'http://wpad/p.pac' },
)
check('a GSettings string loses its quoting', parseGsettingsValue("'127.0.0.1'\n"), '127.0.0.1')
check('a GSettings number is untouched', parseGsettingsValue('10808\n'), '10808')

// --- 5. The environment fallback and the platform chain --------------------
check('HTTPS_PROXY is read first', readEnvironmentProxy({ HTTPS_PROXY: 'http://127.0.0.1:7890' }), {
  proxy: 'http://127.0.0.1:7890',
  detail: 'environment variable HTTPS_PROXY',
})
check('the lower-case spelling is read too', readEnvironmentProxy({ https_proxy: '127.0.0.1:7890' }), {
  proxy: 'http://127.0.0.1:7890',
  detail: 'environment variable https_proxy',
})
check('HTTPS_PROXY wins over HTTP_PROXY', readEnvironmentProxy({
  HTTP_PROXY: 'http://127.0.0.1:1081',
  HTTPS_PROXY: 'http://127.0.0.1:1082',
}), { proxy: 'http://127.0.0.1:1082', detail: 'environment variable HTTPS_PROXY' })
check('an empty environment reads as nothing', readEnvironmentProxy({}), undefined)

// An unknown platform skips the probes entirely, which is how the chain's
// fallback order is testable without a registry.
const fromEnv = readSystemProxy({ platform: 'aix', env: { ALL_PROXY: 'socks5://127.0.0.1:1080' } })
check('an unknown platform falls back to the environment', fromEnv.proxy, 'socks5://127.0.0.1:1080')
check('the source names the environment', fromEnv.source, 'env')
check('the platform is reported', fromEnv.platform, 'aix')
const nothing = readSystemProxy({ platform: 'aix', env: {} })
check('nothing configured reads as an empty proxy', nothing.proxy, '')
check('nothing configured names its source', nothing.source, 'none')

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
