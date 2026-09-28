/**
 * `dsh-proxy`: route model-API requests through an HTTP/SOCKS proxy
 * without modifying DeepSeek Harness source. It wraps `globalThis.fetch` —
 * the transport both the DeepSeek adapter and the pi-ai SDK clients use — and
 * sends only model-API hosts through a proxy dispatcher. Web search, web
 * fetch, MCP, and every other host keep the direct path.
 *
 * The settings seam is DSH 0.1.7's: a `volatile()` config field is edited in
 * place by the settings document, so the running instance re-reads the value
 * on `loader/volatile-update` rather than being remounted. `apply` is
 * therefore installed once and {@link readConfig} is consulted per refresh.
 * @module dsh-proxy
 */
import type { Context } from '@deepseek-ai/cordis';
import type { PluginConfig } from './config.js';
export { Config, assertValid, readConfig, SUPPORTED_PROXY_SCHEMES } from './config.js';
export type { HttpProxyConfig, PluginConfig } from './config.js';
export { DEFAULT_DEEPSEEK_HOST, DEFAULT_MODEL_HOST_SUFFIXES, DEFAULT_MODEL_HOSTS, createProxyFetch, createRoutingFetch, hostnameOf, matchesHostEntry, normalizeHostEntry, shouldProxy, urlOf, } from './proxy.js';
export type { ProxyFetch } from './proxy.js';
export { PROFILE_PATCH_FILE, PROXY_ENTRY_ID, PROXY_IDENTITIES, PROXY_PACKAGE_NAME, profilePatchPath, pruneProxyEntry, pruneProxyEntryFromProfile, } from './profile-patch.js';
export type { PatchPruneResult, ProxyIdentity, ProxyRowCleanup } from './profile-patch.js';
/** Plugin short name (also the profile entry id that carries its settings). */
export declare const name = "dsh-proxy";
/**
 * Install the routing wrapper. The configuration is re-read per refresh, so a
 * settings change reaches the next request without a restart; an empty `proxy`
 * deactivates routing and restores the platform fetch.
 * @param ctx - the Cordis context this plugin mounts into.
 * @param config - the parsed plugin config; its fields are live references.
 */
export declare function apply(ctx: Context, config: PluginConfig): void;
//# sourceMappingURL=index.d.ts.map