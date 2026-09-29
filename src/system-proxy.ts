/**
 * Read the proxy the operating system is configured with.
 *
 * The settings page offers a "use the system proxy" switch, and the Host half
 * needs the same reading to route with it, so this module owns both: one
 * synchronous probe per platform plus the pure parsers behind them.
 *
 * Windows is read from the per-user WinINET key the Settings app, Internet
 * Options, and every local proxy client (Clash, v2rayN, …) write:
 * `ProxyEnable` plus `ProxyServer`, with `AutoConfigURL` reporting the PAC
 * case this plugin cannot resolve. macOS is read from `scutil --proxy`, Linux
 * from the GNOME proxy GSettings. Environment variables are the fallback on
 * every platform, and nothing here throws: a probe that fails is simply an
 * answer of "no proxy found".
 *
 * Every probe runs with a timeout in the Host process and is deliberately
 * synchronous — the reading feeds a routing decision (and one click on a
 * checkbox), where a few milliseconds of `reg.exe` beats a racing async
 * refresh.
 * @module dsh-proxy/system-proxy
 */

import { execFileSync } from 'node:child_process'
import { SUPPORTED_PROXY_SCHEMES } from './config.js'
import type { SystemProxyReading } from './rpc-contract.js'

/** The per-user WinINET key Windows keeps its proxy settings in. */
export const WINDOWS_INTERNET_SETTINGS_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** Environment variables consulted, in priority order. */
export const PROXY_ENV_NAMES: readonly string[] = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
]

/** How long one probe may take before the reading gives up on it. */
const PROBE_TIMEOUT_MS = 5000

/**
 * Run one probe program and read its output.
 *
 * Any failure — a missing binary, an exit status, the timeout, a refused pipe —
 * is an absent answer, never an exception: a machine with no `reg.exe` still
 * gets a reading (from the environment variables).
 */
function probe(file: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync(file, args, {
      // Everything parsed here is ASCII (value names, hosts, ports), and
      // `latin1` maps every byte one-to-one, so a console code page the probe
      // happens to write in cannot corrupt the parse.
      encoding: 'latin1',
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return undefined
  }
}

/** Compose a reading, leaving `pacUrl` off entirely when there is none. */
function reading(fields: Omit<SystemProxyReading, 'pacUrl'>, pacUrl: string | undefined): SystemProxyReading {
  return pacUrl === undefined || pacUrl.length === 0 ? fields : { ...fields, pacUrl }
}

/**
 * Normalize one proxy value into the URL form the plugin's `proxy` setting
 * accepts.
 *
 * A bare `host:port` (what Windows and the environment variables usually
 * carry) is read as HTTP, which is also what the tooling means by it; an
 * explicit scheme is kept when this plugin supports it. Embedded credentials
 * survive, because a corporate proxy usually needs them.
 * @param value - a raw proxy value.
 * @returns the normalized URL, or undefined when it is empty or unusable.
 */
export function normalizeProxyValue(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return undefined
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  if (!SUPPORTED_PROXY_SCHEMES.includes(scheme)) return undefined
  if (parsed.hostname.length === 0) return undefined
  const credentials = parsed.username.length > 0
    ? `${parsed.username}${parsed.password.length > 0 ? `:${parsed.password}` : ''}@`
    : ''
  return `${scheme}://${credentials}${parsed.host}`
}

/** One entry of Windows' `ProxyServer` value. */
export interface WindowsProxyEntry {
  /** Target protocol an entry was declared for, or undefined for a shared one. */
  target?: string
  /** Normalized proxy URL. */
  url: string
}

/**
 * Parse Windows' `ProxyServer` value.
 *
 * Windows accepts either one shared entry (`127.0.0.1:10808`) or one per
 * target protocol (`http=127.0.0.1:10809;https=127.0.0.1:10808`), with
 * `socks` naming a SOCKS proxy. Unusable entries are dropped rather than
 * failing the whole reading.
 * @param value - the raw registry value.
 * @returns every usable entry, in the order Windows listed them.
 */
export function parseWindowsProxyServer(value: string): WindowsProxyEntry[] {
  const entries: WindowsProxyEntry[] = []
  for (const part of value.split(';')) {
    const trimmed = part.trim()
    if (trimmed.length === 0) continue
    const separator = trimmed.indexOf('=')
    const target = separator === -1 ? undefined : trimmed.slice(0, separator).trim().toLowerCase()
    const raw = separator === -1 ? trimmed : trimmed.slice(separator + 1).trim()
    const bare = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    const url = target === 'socks' && !bare ? normalizeProxyValue(`socks5://${raw}`) : normalizeProxyValue(raw)
    if (url === undefined) continue
    entries.push(target === undefined ? { url } : { target, url })
  }
  return entries
}

/**
 * Target-protocol priority for a per-protocol `ProxyServer` value: the model
 * requests this plugin routes are HTTPS, so the `https` entry is the one that
 * speaks to them; a shared entry covers everything at once.
 */
const WINDOWS_TARGET_PRIORITY: readonly (string | undefined)[] = ['https', 'http', undefined, 'socks']

/**
 * Pick the entry to route with.
 * @param entries - parsed `ProxyServer` entries.
 * @returns the preferred entry, or undefined when there is none.
 */
export function pickWindowsProxy(entries: readonly WindowsProxyEntry[]): WindowsProxyEntry | undefined {
  for (const target of WINDOWS_TARGET_PRIORITY) {
    const match = entries.find(entry => entry.target === target)
    if (match !== undefined) return match
  }
  return entries[0]
}

/** The WinINET values this plugin reads, as parsed data. */
export interface WindowsProxyRegistry {
  /** `ProxyEnable`: whether the explicit proxy is switched on. */
  enable: boolean
  /** `ProxyServer`, empty when absent. */
  server: string
  /** `AutoConfigURL`: the PAC script, empty when absent. */
  pacUrl: string
  /** `AutoDetect`: whether automatic (WPAD) detection is on. */
  autoDetect: boolean
}

/**
 * Parse `reg query` output for the WinINET key.
 * @param stdout - the command's output.
 * @returns the four values, with absent ones left at their resting state.
 */
export function parseWindowsRegistry(stdout: string): WindowsProxyRegistry {
  const values = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+REG_[A-Z_]+\s+(.*)$/.exec(line)
    if (match === null) continue
    const name = match[1]
    const data = match[2]
    if (name === undefined || data === undefined) continue
    values.set(name.toLowerCase(), data.trim())
  }
  const enabled = (name: string): boolean => {
    const data = values.get(name)
    if (data === undefined) return false
    return Number.parseInt(data.replace(/^0x/i, ''), 16) !== 0
  }
  return {
    enable: enabled('proxyenable'),
    server: values.get('proxyserver') ?? '',
    pacUrl: values.get('autoconfigurl') ?? '',
    autoDetect: enabled('autodetect'),
  }
}

/**
 * Read Windows' proxy configuration.
 * @returns the reading, or undefined when the registry could not be queried.
 */
export function readWindowsSystemProxy(): SystemProxyReading | undefined {
  const stdout = probe('reg.exe', ['query', WINDOWS_INTERNET_SETTINGS_KEY])
  if (stdout === undefined) return undefined
  const registry = parseWindowsRegistry(stdout)
  const base = { source: 'windows-registry' as const, platform: 'win32' }
  if (!registry.enable || registry.server.length === 0) {
    const detail = registry.pacUrl.length > 0
      ? `Windows Internet Settings use the auto-config script ${registry.pacUrl}`
      : registry.autoDetect
        ? 'Windows Internet Settings enable automatic proxy detection'
        : 'Windows Internet Settings declare no proxy'
    return reading({ ...base, proxy: '', detail }, registry.pacUrl)
  }
  const chosen = pickWindowsProxy(parseWindowsProxyServer(registry.server))
  if (chosen === undefined) {
    return reading(
      { ...base, proxy: '', detail: `Windows Internet Settings declare "${registry.server}", which is not a usable proxy URL` },
      registry.pacUrl,
    )
  }
  return reading(
    { ...base, proxy: chosen.url, detail: `Windows Internet Settings: ${registry.server}` },
    registry.pacUrl,
  )
}

/** What a `scutil --proxy` reading produced. */
export interface ScutilReading {
  /** Normalized proxy URL, empty when macOS declares none. */
  proxy: string
  /** One-line summary for logs. */
  detail: string
  /** The system SOCKS/PAC URL, when the reading carried one. */
  pacUrl?: string
}

/**
 * Parse `scutil --proxy` output.
 * @param stdout - the command's output.
 * @returns the preferred proxy and a summary.
 */
export function parseScutilProxy(stdout: string): ScutilReading {
  const values = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator === -1) continue
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
  }
  const candidates: readonly { enable: string; host: string; port: string; scheme: string }[] = [
    { enable: 'HTTPSEnable', host: 'HTTPSProxy', port: 'HTTPSPort', scheme: 'http' },
    { enable: 'HTTPEnable', host: 'HTTPProxy', port: 'HTTPPort', scheme: 'http' },
    { enable: 'SOCKSEnable', host: 'SOCKSProxy', port: 'SOCKSPort', scheme: 'socks5' },
  ]
  for (const candidate of candidates) {
    if ((values.get(candidate.enable) ?? '0') !== '1') continue
    const host = values.get(candidate.host) ?? ''
    if (host.length === 0) continue
    const port = values.get(candidate.port) ?? ''
    const url = normalizeProxyValue(`${candidate.scheme}://${host}${port.length > 0 ? `:${port}` : ''}`)
    if (url === undefined) continue
    return { proxy: url, detail: `macOS system proxy: ${host}:${port}` }
  }
  const pac = values.get('ProxyAutoConfigURLString') ?? ''
  return pac.length > 0
    ? { proxy: '', detail: `macOS uses the auto-config script ${pac}`, pacUrl: pac }
    : { proxy: '', detail: 'macOS declares no proxy' }
}

/**
 * Read macOS' proxy configuration.
 * @returns the reading, or undefined when `scutil` could not be queried.
 */
export function readMacSystemProxy(): SystemProxyReading | undefined {
  const stdout = probe('scutil', ['--proxy'])
  if (stdout === undefined) return undefined
  const parsed = parseScutilProxy(stdout)
  return reading(
    { proxy: parsed.proxy, source: 'macos-scutil', detail: parsed.detail, platform: 'darwin' },
    parsed.pacUrl,
  )
}

/**
 * Read a GSettings value: the CLI prints strings single-quoted.
 * @param output - the command's output.
 * @returns the value without the command's quoting.
 */
export function parseGsettingsValue(output: string): string {
  const trimmed = output.trim()
  return trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")
    ? trimmed.slice(1, -1)
    : trimmed
}

/**
 * Read Linux' proxy configuration from the GNOME proxy GSettings.
 * @returns the reading; a desktop without those schemas reads as "no proxy".
 */
export function readLinuxSystemProxy(): SystemProxyReading {
  const base = { source: 'linux-gsettings' as const, platform: 'linux' }
  const modeOutput = probe('gsettings', ['get', 'org.gnome.system.proxy', 'mode'])
  if (modeOutput === undefined) {
    return reading({ ...base, proxy: '', detail: 'no GSettings proxy configuration is readable' }, undefined)
  }
  const mode = parseGsettingsValue(modeOutput)
  if (mode !== 'manual') {
    return reading({ ...base, proxy: '', detail: `GSettings proxy mode is "${mode}"` }, undefined)
  }
  for (const scheme of ['https', 'http', 'socks'] as const) {
    const hostOutput = probe('gsettings', ['get', `org.gnome.system.proxy.${scheme}`, 'host'])
    if (hostOutput === undefined) continue
    const host = parseGsettingsValue(hostOutput)
    if (host.length === 0) continue
    const portOutput = probe('gsettings', ['get', `org.gnome.system.proxy.${scheme}`, 'port'])
    const port = portOutput === undefined ? '' : parseGsettingsValue(portOutput)
    const withScheme = scheme === 'socks' ? `socks5://${host}` : `http://${host}`
    const url = normalizeProxyValue(`${withScheme}${Number(port) > 0 ? `:${port}` : ''}`)
    if (url === undefined) continue
    return reading({ ...base, proxy: url, detail: `GSettings ${scheme} proxy: ${host}:${port}` }, undefined)
  }
  return reading({ ...base, proxy: '', detail: 'GSettings manual mode declares no host' }, undefined)
}

/**
 * Read the proxy from the environment.
 * @param env - the environment to read (injectable for tests).
 * @returns the first usable proxy plus the variable it came from, or undefined.
 */
export function readEnvironmentProxy(env: NodeJS.ProcessEnv): { proxy: string; detail: string } | undefined {
  for (const name of PROXY_ENV_NAMES) {
    const value = env[name]
    if (value === undefined || value.trim().length === 0) continue
    const url = normalizeProxyValue(value)
    if (url === undefined) continue
    return { proxy: url, detail: `environment variable ${name}` }
  }
  return undefined
}

/**
 * Read the proxy this machine is configured with.
 *
 * The platform's own configuration wins; the environment variables are the
 * fallback, which is also the whole answer on a platform this module does not
 * know. A platform whose only configuration is a PAC script reports an empty
 * proxy plus the script URL.
 * @param options - environment and platform overrides, for tests.
 * @returns a reading; never throws.
 */
export function readSystemProxy(
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): SystemProxyReading {
  const platform = options.platform ?? process.platform
  const native = platform === 'win32'
    ? readWindowsSystemProxy()
    : platform === 'darwin'
      ? readMacSystemProxy()
      : platform === 'linux'
        ? readLinuxSystemProxy()
        : undefined
  if (native !== undefined && native.proxy.length > 0) return native
  const fromEnv = readEnvironmentProxy(options.env ?? process.env)
  if (fromEnv !== undefined) {
    return reading({ proxy: fromEnv.proxy, source: 'env', detail: fromEnv.detail, platform }, undefined)
  }
  if (native !== undefined) return native
  return reading({ proxy: '', source: 'none', detail: 'no system proxy configuration was found', platform }, undefined)
}
