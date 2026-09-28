/**
 * Configuration schema and validation for `dsh-proxy`.
 *
 * DSH 0.1.7 derives the settings page straight from this schema: the Loader
 * reads `entry.fiber.runtime.Config` for the profile entry that mounts the
 * plugin, and a field marked `volatile()` becomes a live reference. The
 * settings document then edits that reference in place and announces it
 * through `loader/volatile-update`, instead of remounting the plugin — which
 * is what replaced the `settings.installSection` seam the 0.1.2-era API used.
 * A field that is not volatile is not offered by the settings page at all.
 * @module dsh-proxy/config
 */

import z from '@deepseek-ai/schemastery'

/** Proxy URL schemes `undici`'s `ProxyAgent` accepts. */
export const SUPPORTED_PROXY_SCHEMES: readonly string[] = [
  'http',
  'https',
  'socks4',
  'socks4a',
  'socks5',
  'socks5h',
]

/**
 * The plugin configuration as plain values.
 *
 * The schema output carries `volatile()` references instead; {@link readConfig}
 * is the single place that unwraps them, so everything downstream — routing,
 * validation, and the browser half's host suggestions — works with ordinary
 * JSON-shaped data.
 */
export interface HttpProxyConfig {
  /**
   * Proxy URL. Empty means the plugin is inactive and no request is routed.
   * Supported schemes: `http:`, `https:`, `socks4:`, `socks4a:`, `socks5:`,
   * `socks5h:`.
   */
  proxy: string
  /**
   * Hostnames routed through the proxy. Empty means "auto-detect all model-API
   * hosts" (`api.deepseek.com`, `DEEPSEEK_BASE_URL`, and every `llm-pi-ai`
   * gateway `baseURL`); non-empty means route ONLY these hosts, ignoring
   * auto-detection.
   */
  proxyHosts: string[]
  /** Hostnames that must never be routed, even when auto-detected or listed. */
  excludeHosts: string[]
}

/** Runtime schema for the plugin entry; also the settings page's form. */
export const Config = z.object({
  proxy: z.string().default('').volatile(),
  proxyHosts: z.array(z.string()).default([]).volatile(),
  excludeHosts: z.array(z.string()).default([]).volatile(),
})

/**
 * Parsed configuration as the Loader hands it to `apply`.
 *
 * Derived from the schema rather than restated, so the two can never drift:
 * each field is its `volatile()` reference, read with `.get()`.
 */
export type PluginConfig = ReturnType<typeof Config>

/** Keep only the string entries of a parsed config array. */
function hostList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/**
 * Unwrap the live configuration references into plain values.
 * @param config - the parsed plugin config the Loader supplied.
 * @returns the current configuration snapshot.
 */
export function readConfig(config: PluginConfig): HttpProxyConfig {
  const proxy = config.proxy.get()
  return {
    proxy: typeof proxy === 'string' ? proxy : '',
    proxyHosts: hostList(config.proxyHosts.get()),
    excludeHosts: hostList(config.excludeHosts.get()),
  }
}

/**
 * Reject a proxy URL this plugin cannot serve. Called before a dispatcher is
 * built, so a bad URL degrades to "routing off" with a log line instead of
 * failing the plugin mount.
 * @param config - the resolved section to check.
 * @throws Error naming the offending proxy URL.
 */
export function assertValid(config: Pick<HttpProxyConfig, 'proxy'>): void {
  if (config.proxy.length === 0) return
  let parsed: URL
  try {
    parsed = new URL(config.proxy)
  } catch {
    throw new Error(`dsh-proxy: invalid proxy URL "${config.proxy}"`)
  }
  const scheme = parsed.protocol.replace(/:$/, '')
  if (!SUPPORTED_PROXY_SCHEMES.includes(scheme)) {
    throw new Error(
      `dsh-proxy: proxy URL "${config.proxy}" uses unsupported scheme "${parsed.protocol}";`
      + ` supported schemes: ${SUPPORTED_PROXY_SCHEMES.join(', ')}`,
    )
  }
}
