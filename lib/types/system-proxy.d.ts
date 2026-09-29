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
import type { SystemProxyReading } from './rpc-contract.js';
/** The per-user WinINET key Windows keeps its proxy settings in. */
export declare const WINDOWS_INTERNET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
/** Environment variables consulted, in priority order. */
export declare const PROXY_ENV_NAMES: readonly string[];
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
export declare function normalizeProxyValue(value: string): string | undefined;
/** One entry of Windows' `ProxyServer` value. */
export interface WindowsProxyEntry {
    /** Target protocol an entry was declared for, or undefined for a shared one. */
    target?: string;
    /** Normalized proxy URL. */
    url: string;
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
export declare function parseWindowsProxyServer(value: string): WindowsProxyEntry[];
/**
 * Pick the entry to route with.
 * @param entries - parsed `ProxyServer` entries.
 * @returns the preferred entry, or undefined when there is none.
 */
export declare function pickWindowsProxy(entries: readonly WindowsProxyEntry[]): WindowsProxyEntry | undefined;
/** The WinINET values this plugin reads, as parsed data. */
export interface WindowsProxyRegistry {
    /** `ProxyEnable`: whether the explicit proxy is switched on. */
    enable: boolean;
    /** `ProxyServer`, empty when absent. */
    server: string;
    /** `AutoConfigURL`: the PAC script, empty when absent. */
    pacUrl: string;
    /** `AutoDetect`: whether automatic (WPAD) detection is on. */
    autoDetect: boolean;
}
/**
 * Parse `reg query` output for the WinINET key.
 * @param stdout - the command's output.
 * @returns the four values, with absent ones left at their resting state.
 */
export declare function parseWindowsRegistry(stdout: string): WindowsProxyRegistry;
/**
 * Read Windows' proxy configuration.
 * @returns the reading, or undefined when the registry could not be queried.
 */
export declare function readWindowsSystemProxy(): SystemProxyReading | undefined;
/** What a `scutil --proxy` reading produced. */
export interface ScutilReading {
    /** Normalized proxy URL, empty when macOS declares none. */
    proxy: string;
    /** One-line summary for logs. */
    detail: string;
    /** The system SOCKS/PAC URL, when the reading carried one. */
    pacUrl?: string;
}
/**
 * Parse `scutil --proxy` output.
 * @param stdout - the command's output.
 * @returns the preferred proxy and a summary.
 */
export declare function parseScutilProxy(stdout: string): ScutilReading;
/**
 * Read macOS' proxy configuration.
 * @returns the reading, or undefined when `scutil` could not be queried.
 */
export declare function readMacSystemProxy(): SystemProxyReading | undefined;
/**
 * Read a GSettings value: the CLI prints strings single-quoted.
 * @param output - the command's output.
 * @returns the value without the command's quoting.
 */
export declare function parseGsettingsValue(output: string): string;
/**
 * Read Linux' proxy configuration from the GNOME proxy GSettings.
 * @returns the reading; a desktop without those schemas reads as "no proxy".
 */
export declare function readLinuxSystemProxy(): SystemProxyReading;
/**
 * Read the proxy from the environment.
 * @param env - the environment to read (injectable for tests).
 * @returns the first usable proxy plus the variable it came from, or undefined.
 */
export declare function readEnvironmentProxy(env: NodeJS.ProcessEnv): {
    proxy: string;
    detail: string;
} | undefined;
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
export declare function readSystemProxy(options?: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
}): SystemProxyReading;
//# sourceMappingURL=system-proxy.d.ts.map