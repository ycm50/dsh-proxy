/**
 * Configuration schema and validation for `dsh-http-proxy`.
 *
 * DSH 0.1.7 derives the settings page straight from this schema: the Loader
 * reads `entry.fiber.runtime.Config` for the profile entry that mounts the
 * plugin, and a field marked `volatile()` becomes a live reference. The
 * settings document then edits that reference in place and announces it
 * through `loader/volatile-update`, instead of remounting the plugin — which
 * is what replaced the `settings.installSection` seam the 0.1.2-era API used.
 * A field that is not volatile is not offered by the settings page at all.
 * @module dsh-http-proxy/config
 */
import z from '@deepseek-ai/schemastery';
/** Proxy URL schemes `undici`'s `ProxyAgent` accepts. */
export declare const SUPPORTED_PROXY_SCHEMES: readonly string[];
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
    proxy: string;
    /**
     * Hostnames routed through the proxy. Empty means "auto-detect all model-API
     * hosts" (`api.deepseek.com`, `DEEPSEEK_BASE_URL`, and every `llm-pi-ai`
     * gateway `baseURL`); non-empty means route ONLY these hosts, ignoring
     * auto-detection.
     */
    proxyHosts: string[];
    /** Hostnames that must never be routed, even when auto-detected or listed. */
    excludeHosts: string[];
}
/** Runtime schema for the plugin entry; also the settings page's form. */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    proxy: z<string, string, "volatile-defined">;
    proxyHosts: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    excludeHosts: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    proxy: z<string, string, "volatile-defined">;
    proxyHosts: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    excludeHosts: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
}>>, "plain">;
/**
 * Parsed configuration as the Loader hands it to `apply`.
 *
 * Derived from the schema rather than restated, so the two can never drift:
 * each field is its `volatile()` reference, read with `.get()`.
 */
export type PluginConfig = ReturnType<typeof Config>;
/**
 * Unwrap the live configuration references into plain values.
 * @param config - the parsed plugin config the Loader supplied.
 * @returns the current configuration snapshot.
 */
export declare function readConfig(config: PluginConfig): HttpProxyConfig;
/**
 * Reject a proxy URL this plugin cannot serve. Called before a dispatcher is
 * built, so a bad URL degrades to "routing off" with a log line instead of
 * failing the plugin mount.
 * @param config - the resolved section to check.
 * @throws Error naming the offending proxy URL.
 */
export declare function assertValid(config: Pick<HttpProxyConfig, 'proxy'>): void;
//# sourceMappingURL=config.d.ts.map