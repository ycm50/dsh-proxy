/**
 * `dsh-proxy`: route model-API requests through an HTTP/SOCKS proxy
 * without modifying DeepSeek Harness source. It wraps `globalThis.fetch` —
 * the transport both the DeepSeek adapter and the pi-ai SDK clients use — and
 * decides, per host, whether a request takes the proxy or this plugin's hardened
 * direct channel. A host on the force list always takes the proxy; every other
 * host starts direct and moves onto the proxy only when direct does not answer
 * within a second or fails outright, and the channel that answers is kept for
 * the session (see `dsh-proxy/routing`).
 *
 * The settings seam is DSH 0.1.7's: a `volatile()` config field is edited in
 * place by the settings document, so the running instance re-reads the value
 * on `loader/volatile-update` rather than being remounted. `apply` is
 * therefore installed once and {@link readConfig} is consulted per refresh.
 * @module dsh-proxy
 */
import type { Context } from '@deepseek-ai/cordis';
import type { PluginConfig } from './config.js';
export { Config, SUBPROCESS_PROXY_SCHEMES, assertValid, isValidSubprocessProxy, readConfig, SUPPORTED_PROXY_SCHEMES } from './config.js';
export type { HttpProxyConfig, PluginConfig } from './config.js';
export { createHardenedChannel, createProxyFetch, createRoutingFetch, headerPairs, hostnameOf, isLanHostname, isLoopbackHostname, matchesHostEntry, normaliseFetchCall, normalizeHostEntry, shouldForceProxy, urlOf, } from './proxy.js';
export type { ChannelOptions, HardenedChannel, NormalisedCall, ProxyFetch, RoutingOptions } from './proxy.js';
export { RoutingDispatcher, installGlobalDispatcher, isExemptHostname, liveDispatcherCount, uninstallGlobalDispatcher, } from './dispatch.js';
export type { RoutingInput } from './dispatch.js';
export { DEFAULT_STABILITY, HAPPY_EYEBALLS_ATTEMPT_MS, POOLED_IDLE_MAX_MS, POOLED_IDLE_WINDOW_MS, STABILITY_BOUNDS, STABILITY_FIELDS, TCP_KEEPALIVE_DELAY_MS, agentOptionsOf, connectorOptionsOf, describeStability, readStability, stabilityIsDefault, } from './stability.js';
export type { HardenedAgentOptions, HardenedConnectOptions, StabilityConfig, StabilityField } from './stability.js';
export { ProxyObserver, observerFromEnv } from './observe.js';
export type { ObservedChannel, ObserverOptions, ObserverStats, ObserverSummary, RequestSample, } from './observe.js';
export { FIRST_CHANNEL, PROBE_TIMEOUT_CODE, PROBE_TIMEOUT_MS, RouteMemory, describeRouting, otherChannel, } from './routing.js';
export type { RouteAttempt, RouteChannel, RouteDecision, RouteState } from './routing.js';
export { isAborted, isReplayableRequest, isRetryableTransportError, transportCodeOf, withTransportRetry, } from './retry.js';
export type { RetryAttempt, RetryPolicy } from './retry.js';
export { PROXY_ENV_NAMES, WINDOWS_INTERNET_SETTINGS_KEY, normalizeProxyValue, parseGsettingsValue, parseScutilProxy, parseWindowsProxyServer, parseWindowsRegistry, pickWindowsProxy, readEnvironmentProxy, readMacSystemProxy, readSystemProxy, readWindowsSystemProxy, } from './system-proxy.js';
export type { ScutilReading, WindowsProxyEntry, WindowsProxyRegistry, } from './system-proxy.js';
export { SYSTEM_PROXY_CHANNEL, SYSTEM_PROXY_ENDPOINT, SYSTEM_PROXY_ROUTE, } from './rpc-contract.js';
export type { ClientRequestEnvelope, RpcFailure, RpcResult, ServerResponseEnvelope, SystemProxyReading, SystemProxySource, } from './rpc-contract.js';
export { installSystemProxyRpc } from './rpc.js';
export { PROFILE_MANIFEST_FILE, PROFILE_PATCH_FILE, PROXY_ENTRY_ID, PROXY_IDENTITIES, PROXY_PACKAGE_NAME, planRowCleanup, profileDir, profileManifestPath, profilePatchPath, pruneProxyEntry, pruneProxyEntryFromProfile, readBundleSelection, readProxyEntryState, stripProxyEntryConfig, stripProxyEntryConfigFromProfile, } from './profile-patch.js';
export type { BundleSelection, PatchPruneResult, PatchStripResult, ProxyIdentity, ProxyRowCleanup, ProxyRowState, } from './profile-patch.js';
/** Plugin short name (also the profile entry id that carries its settings). */
export declare const name = "dsh-proxy";
/** Where the record file lives when the environment does not name one. */
export declare function defaultRecordPath(env?: NodeJS.ProcessEnv): string;
/**
 * Install the two interception layers — the process-wide dispatcher and the
 * routing `fetch` — plus the Connection channel that lets the settings page
 * read this machine's proxy.
 *
 * Why both layers: the dispatcher covers callers that captured `fetch` or use
 * undici directly, and the wrapper covers callers that pass their own
 * dispatcher; between them, every in-process request takes this plugin's
 * decision, and every one travels on a hardened channel. The configuration is
 * re-read per refresh, so a settings change reaches the next request without a
 * restart; an empty `proxy` deactivates routing and restores both globals, and
 * `useSystemProxy` exchanges the typed address for the machine's own.
 * @param ctx - the Cordis context this plugin mounts into.
 * @param config - the parsed plugin config; its fields are live references.
 */
export declare function apply(ctx: Context, config: PluginConfig): void;
//# sourceMappingURL=index.d.ts.map