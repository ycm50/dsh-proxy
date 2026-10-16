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
import z from '@deepseek-ai/schemastery';
import type { StabilityConfig, StabilityWarn } from './stability.js';
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
     * Hostnames routed through the proxy, each an umbrella covering itself and
     * its subdomains. This is the entire routed set: there is no auto-detected
     * list behind it, so an empty array routes nothing at all.
     */
    proxyHosts: string[];
    /**
     * Hostnames that must never be routed. Judged before `proxyHosts`, so an
     * entry here is direct even when the same host is also listed there.
     */
    excludeHosts: string[];
    /**
     * Whether to take the proxy address from the operating system instead of the
     * typed one. When set, the machine's own configuration is read for every
     * routing decision, and `proxy` is only the fallback for a machine that has
     * nothing configured.
     */
    useSystemProxy: boolean;
    /**
     * Export the proxy to child processes (`pnpm`, `git`, …) through
     * `process.env`.
     *
     * The plugin writes both casings of `HTTP_PROXY` / `HTTPS_PROXY` and
     * `NO_PROXY` — the readers disagree on which one they prefer — and stores
     * what it replaced so unloading restores the original values. A proxy URL a
     * Node child cannot parse (`socks5:`, or anything `new URL` rejects) is
     * never injected; see {@link isValidSubprocessProxy}.
     *
     * It is independent of the host lists: it carries the same resolved address
     * to the programs that cannot see the in-process routing, and an
     * `excludeHosts` entry cannot carve out a child process, so the address a
     * child inherits is the one routing itself uses.
     */
    proxySubprocesses: boolean;
    /**
     * Effective stability settings after clamping (see `dsh-proxy/stability`).
     *
     * Kept nested rather than flattened here so the request path receives one
     * coherent snapshot: the agent options and the retry policy are built from
     * exactly this object, and a channel rebuilt from a half-applied edit would
     * mix two generations of timeouts.
     */
    stability: StabilityConfig;
}
/** Runtime schema for the plugin entry; also the settings page's form. */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    proxy: z<string, string, "volatile-defined">;
    proxyHosts: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    excludeHosts: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    useSystemProxy: z<boolean, boolean, "volatile-defined">;
    proxySubprocesses: z<boolean, boolean, "volatile-defined">;
    connectTimeoutMs: z<number, number, "volatile-defined">;
    responseTimeoutMs: z<number, number, "volatile-defined">;
    streamIdleTimeoutMs: z<number, number, "volatile-defined">;
    retryCount: z<number, number, "volatile-defined">;
    retryDelayMs: z<number, number, "volatile-defined">;
    retryOnPossibleDelivery: z<boolean, boolean, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    proxy: z<string, string, "volatile-defined">;
    proxyHosts: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    excludeHosts: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    useSystemProxy: z<boolean, boolean, "volatile-defined">;
    proxySubprocesses: z<boolean, boolean, "volatile-defined">;
    connectTimeoutMs: z<number, number, "volatile-defined">;
    responseTimeoutMs: z<number, number, "volatile-defined">;
    streamIdleTimeoutMs: z<number, number, "volatile-defined">;
    retryCount: z<number, number, "volatile-defined">;
    retryDelayMs: z<number, number, "volatile-defined">;
    retryOnPossibleDelivery: z<boolean, boolean, "volatile-defined">;
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
export declare function readConfig(config: PluginConfig, warn?: StabilityWarn): HttpProxyConfig;
/**
 * Proxy URL schemes that can be handed to a child process through the
 * environment.
 *
 * Deliberately narrower than {@link SUPPORTED_PROXY_SCHEMES}: this is not
 * about what `undici` can serve, but about what the child process will
 * accept. `NODE_USE_ENV_PROXY` reads `HTTPS_PROXY` / `HTTP_PROXY` and
 * understands only `http:` and `https:`; a `socks5:` value there is either
 * silently ignored or fatal, so it must never be written.
 */
export declare const SUBPROCESS_PROXY_SCHEMES: readonly string[];
/**
 * Whether a proxy URL may be exported to child processes as
 * `HTTPS_PROXY` / `HTTP_PROXY`.
 *
 * A malformed value is not merely useless — with `NODE_USE_ENV_PROXY=1` set,
 * a Node child process (and `pnpm` is one) exits immediately on a value it
 * cannot parse, so a bad environment variable breaks plugin installation
 * outright. This is why the check is "could this be parsed by `new URL` and
 * is its scheme one of `http`/`https`" and not a pattern match: the child
 * parses it the same way.
 *
 * `undefined` and `''` are invalid on purpose. "No proxy" is not a value to
 * inject; it is the absence of one, and the caller distinguishes the two
 * (nothing is written, and any previous value is restored) rather than writing
 * an empty string that would shadow the machine's real proxy.
 * @param value - the resolved proxy URL, or undefined/empty when unset.
 * @returns whether the value is safe to put in `HTTPS_PROXY`/`HTTP_PROXY`.
 */
export declare function isValidSubprocessProxy(value: string | undefined): boolean;
/**
 * Reject a proxy URL this plugin cannot serve. Called before a dispatcher is
 * built, so a bad URL degrades to "routing off" with a log line instead of
 * failing the plugin mount.
 * @param config - the resolved section to check.
 * @throws Error naming the offending proxy URL.
 */
export declare function assertValid(config: Pick<HttpProxyConfig, 'proxy'>): void;
//# sourceMappingURL=config.d.ts.map