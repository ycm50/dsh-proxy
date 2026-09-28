import z from "@deepseek-ai/schemastery";
import { ProxyAgent, fetch } from "undici";
import { pruneProxyEntryFromProfile } from "./profile-patch.js";
//#region src/config.ts
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
/** Proxy URL schemes `undici`'s `ProxyAgent` accepts. */
const SUPPORTED_PROXY_SCHEMES = [
	"http",
	"https",
	"socks4",
	"socks4a",
	"socks5",
	"socks5h"
];
/** Runtime schema for the plugin entry; also the settings page's form. */
const Config = z.object({
	proxy: z.string().default("").volatile(),
	proxyHosts: z.array(z.string()).default([]).volatile(),
	excludeHosts: z.array(z.string()).default([]).volatile()
});
/** Keep only the string entries of a parsed config array. */
function hostList(value) {
	return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}
/**
* Unwrap the live configuration references into plain values.
* @param config - the parsed plugin config the Loader supplied.
* @returns the current configuration snapshot.
*/
function readConfig(config) {
	const proxy = config.proxy.get();
	return {
		proxy: typeof proxy === "string" ? proxy : "",
		proxyHosts: hostList(config.proxyHosts.get()),
		excludeHosts: hostList(config.excludeHosts.get())
	};
}
/**
* Reject a proxy URL this plugin cannot serve. Called before a dispatcher is
* built, so a bad URL degrades to "routing off" with a log line instead of
* failing the plugin mount.
* @param config - the resolved section to check.
* @throws Error naming the offending proxy URL.
*/
function assertValid(config) {
	if (config.proxy.length === 0) return;
	let parsed;
	try {
		parsed = new URL(config.proxy);
	} catch {
		throw new Error(`dsh-proxy: invalid proxy URL "${config.proxy}"`);
	}
	const scheme = parsed.protocol.replace(/:$/, "");
	if (!SUPPORTED_PROXY_SCHEMES.includes(scheme)) throw new Error(`dsh-proxy: proxy URL "${config.proxy}" uses unsupported scheme "${parsed.protocol}"; supported schemes: ${SUPPORTED_PROXY_SCHEMES.join(", ")}`);
}
//#endregion
//#region src/hosts.ts
/**
* Browser-safe hostname helpers shared by the Host half (routing) and the
* browser card (suggestions). No node imports, so either bundle can inline
* this module without dragging in `undici`.
* @module dsh-proxy/hosts
*/
/** The official DeepSeek adapter's default endpoint host. */
const DEFAULT_DEEPSEEK_HOST = "api.deepseek.com";
/**
* Default model-API hostnames pi-ai's built-in providers use, so auto mode
* proxies a catalog route (e.g. `google`) even when its profile names no
* `baseURL`. Exact hostname matches; see {@link DEFAULT_MODEL_HOST_SUFFIXES}
* for region- or resource-templated endpoints. This mirrors the endpoints the
* installed pi-ai catalog ships (`builtinProviders()`); a pi-ai release that
* adds a provider with a new default endpoint needs its host added here.
*/
const DEFAULT_MODEL_HOSTS = [
	"ai-gateway.vercel.sh",
	"api.ant-ling.com",
	"api.anthropic.com",
	"api.cerebras.ai",
	"api.cloudflare.com",
	"api.fireworks.ai",
	"api.groq.com",
	"api.individual.githubcopilot.com",
	"api.kimi.com",
	"api.minimaxi.com",
	"api.minimax.io",
	"api.mistral.ai",
	"api.moonshot.ai",
	"api.moonshot.cn",
	"api.openai.com",
	"api.together.ai",
	"api.x.ai",
	"api.xiaomimimo.com",
	"api.z.ai",
	"chatgpt.com",
	"gateway.ai.cloudflare.com",
	"generativelanguage.googleapis.com",
	"inference.baseten.co",
	"integrate.api.nvidia.com",
	"open.bigmodel.cn",
	"openrouter.ai",
	"router.huggingface.co",
	"token-plan-ams.xiaomimimo.com",
	"token-plan-cn.xiaomimimo.com",
	"token-plan-sgp.xiaomimimo.com",
	"token-plan.ap-southeast-1.maas.aliyuncs.com",
	"token-plan.cn-beijing.maas.aliyuncs.com"
];
/**
* Default suffixes for templated pi-ai endpoints: `google-vertex` resolves its
* catalog baseURL from `https://{location}-aiplatform.googleapis.com` (the
* actual request lands on `us-central1-aiplatform.googleapis.com` and
* siblings), and `azure-openai-responses` builds
* `https://{resource}.openai.azure.com`. A suffix entry matches the bare
* domain, its subdomains, and its hyphen-joined region hosts.
*/
const DEFAULT_MODEL_HOST_SUFFIXES = [".aiplatform.googleapis.com", ".openai.azure.com"];
/**
* Extract the hostname from an absolute URL string or `URL`.
* @param value - the URL to read.
* @returns the lowercase hostname.
*/
function hostnameOf(value) {
	return value instanceof URL ? value.hostname : new URL(value).hostname;
}
/** Count one-character occurrences; enough for the `:` scan below. */
function countOf(value, needle) {
	let count = 0;
	for (let i = 0; i < value.length; i++) if (value[i] === needle) count++;
	return count;
}
/**
* Normalize a user-entered host entry to the form `shouldProxy` matches
* against (`new URL(url).hostname`). Accepts a plain hostname, `host:port`,
* a bracketed or bare IPv6 literal, an absolute URL (scheme, port, and path
* are all stripped), or a suffix entry (`*.example.com` or `.example.com`,
* both kept as `.example.com`). Returns undefined when nothing usable
* remains.
* @param entry - a raw `proxyHosts` / `excludeHosts` entry.
* @returns the normalized entry, or undefined for an empty/invalid entry.
*/
function normalizeHostEntry(entry) {
	const trimmed = entry.trim();
	if (trimmed.length === 0) return void 0;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) try {
		return new URL(trimmed).hostname.toLowerCase();
	} catch {
		return;
	}
	const beforePath = trimmed.split("/")[0] ?? "";
	let hostPart;
	if (beforePath.startsWith("[")) {
		const close = beforePath.indexOf("]");
		hostPart = close === -1 ? beforePath : beforePath.slice(0, close + 1);
	} else if (countOf(beforePath, ":") === 1) hostPart = beforePath.split(":")[0] ?? "";
	else hostPart = beforePath;
	let bare = hostPart.toLowerCase();
	if (bare.length === 0) return void 0;
	if (bare.includes(":") && !bare.startsWith("[")) bare = `[${bare}]`;
	if (bare.startsWith("*.")) bare = bare.slice(1);
	if (bare.endsWith(".")) bare = bare.slice(0, -1);
	return bare.length > 0 ? bare : void 0;
}
/**
* Whether one hostname is covered by one normalized entry.
*
* An entry is an **umbrella**: it covers its own domain and every host built
* on it, at any depth. Writing the umbrella domain is the whole statement —
* `a.b` covers `a.b`, `*.a.b`, `*.*.a.b`, and so on — so `.a.b` and `*.a.b`
* are accepted spellings of the same entry rather than a different, stronger
* one. The hyphen rule is part of the umbrella because region-templated
* endpoints are siblings, not children: `aiplatform.googleapis.com` covers
* `us-central1-aiplatform.googleapis.com`, the shape `google-vertex` builds
* from its `{location}` template.
*
* The comparison is on the request's URL hostname only, so an entry never
* matches a path, a query, or a port.
* @param hostname - the request hostname to test (already lowercased by `URL`).
* @param entry - one entry from a normalized host set.
* @returns whether the entry covers the hostname.
*/
function matchesHostEntry(hostname, entry) {
	const domain = entry.startsWith(".") ? entry.slice(1) : entry;
	if (domain.length === 0) return false;
	return hostname === domain || hostname.endsWith(`.${domain}`) || hostname.endsWith(`-${domain}`);
}
//#endregion
//#region src/proxy.ts
/**
* Proxy transport and host-routing helpers for `dsh-proxy`.
*
* The plugin does not touch DeepSeek Harness source. It installs a wrapper
* around `globalThis.fetch` — which both the DeepSeek adapter's raw `fetch` and
* the pi-ai SDK clients call — and routes only model-API hosts through a
* proxy dispatcher, leaving every other host (web search, web fetch, MCP, …)
* on the direct path.
* @module dsh-proxy/proxy
*/
/** Extract the absolute URL string from a `fetch` input. */
function urlOf(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}
/**
* Whether a URL's hostname is routed through the proxy.
*
* An entry is an umbrella — it covers its own domain and every host built on
* it at any depth (see {@link matchesHostEntry}) — so a single `a.b` reaches
* `a.b`, `*.a.b`, `*.*.a.b`, and the hyphen-joined region siblings. Malformed
* URLs are never proxied.
*
* Exclusions are judged against the same hostname, and they win: they are not
* a subtraction from the entry set (which could only ever remove an entry
* spelled identically) but a second umbrella test, so excluding `a.b` really
* does keep all of it direct, and excluding `api.a.b` really does carve that
* one child back out.
* @param url - the absolute request URL.
* @param hosts - normalized entries routed through the proxy.
* @param exclude - normalized entries that must never be routed.
* @returns whether the request should travel through the proxy.
*/
function shouldProxy(url, hosts, exclude) {
	try {
		const hostname = new URL(url).hostname;
		let covered = false;
		for (const entry of hosts) if (matchesHostEntry(hostname, entry)) {
			covered = true;
			break;
		}
		if (!covered) return false;
		if (exclude !== void 0) {
			for (const entry of exclude) if (matchesHostEntry(hostname, entry)) return false;
		}
		return true;
	} catch {
		return false;
	}
}
/**
* Create a fetch bound to a proxy dispatcher. `undici`'s `ProxyAgent` accepts
* `http:`, `https:`, `socks4:`, `socks4a:`, `socks5:`, and `socks5h:` proxy URLs.
* @param proxyUrl - the proxy endpoint.
* @returns the proxy-bound fetch and its dispatcher closer.
*/
function createProxyFetch(proxyUrl) {
	const dispatcher = new ProxyAgent(proxyUrl);
	const fetchImpl = ((input, init) => fetch(input, {
		...init,
		dispatcher
	}));
	return {
		fetch: fetchImpl,
		close: () => dispatcher.close()
	};
}
/**
* Wrap a platform fetch so that requests to `hosts` travel through
* `proxyFetch` and everything else keeps the original fetch.
* @param proxyFetch - the proxy-bound fetch.
* @param original - the fetch to keep for non-proxied hosts.
* @param hosts - umbrella entries routed through the proxy.
* @param exclude - umbrella entries that must never be routed.
* @returns the routing fetch.
*/
function createRoutingFetch(proxyFetch, original, hosts, exclude) {
	return ((input, init) => {
		return shouldProxy(urlOf(input), hosts, exclude) ? proxyFetch(input, init) : original(input, init);
	});
}
//#endregion
//#region src/index.ts
/** Plugin short name (also the profile entry id that carries its settings). */
const name = "dsh-proxy";
/** The `llm-pi-ai` namespace, read here for its configured gateway hostnames. */
const PI_AI_NS = "llm-pi-ai";
/**
* The custom model gateways declared in the `llm-pi-ai` settings section.
*
* The section belongs to another plugin, so it is read through the settings
* service's public `describe()` read rather than injected: this plugin must
* keep routing with its composition entry even when no settings provider is
* present, and must not depend on pi-ai's own context.
* @param ctx - the Cordis context, for the optional settings service.
* @returns the configured `baseURL`s, malformed ones included (they are
* pi-ai's to reject, not this plugin's to judge).
*/
function piAiGateways(ctx) {
	const settings = ctx.get("settings");
	if (settings === void 0) return [];
	let served;
	try {
		served = settings.describe().find((row) => String(row.ns) === PI_AI_NS);
	} catch (cause) {
		ctx.logger.warn("dsh-proxy: cannot read the %s settings section (%s); using the built-in model hosts only", PI_AI_NS, cause instanceof Error ? cause.message : String(cause));
		return [];
	}
	const section = served?.value;
	return Object.values(section?.providers ?? {}).map((profile) => profile.baseURL).filter((baseURL) => typeof baseURL === "string" && baseURL.length > 0);
}
/**
* Collect the hostnames that should travel through the proxy: the official
* DeepSeek host (or `DEEPSEEK_BASE_URL`), the default endpoints of the
* built-in pi-ai providers (catalog routes configure no `baseURL` of their
* own), the configured `proxyHosts`, and the custom model gateways declared
* in the `llm-pi-ai` settings section.
*
* Every entry is an umbrella: `a.b` covers `a.b` and the whole subtree under
* it (see `matchesHostEntry`), so a domain is named once rather than per
* endpoint.
* @param ctx - the Cordis context, for the optional settings service.
* @param config - the current plugin configuration.
* @returns the routed and excluded entry sets.
*/
function collectProxyHosts(ctx, config) {
	const hosts = /* @__PURE__ */ new Set();
	if (config.proxyHosts.length > 0) for (const host of config.proxyHosts) {
		const normalized = normalizeHostEntry(host);
		if (normalized !== void 0) hosts.add(normalized);
	}
	else {
		hosts.add(DEFAULT_DEEPSEEK_HOST);
		for (const host of DEFAULT_MODEL_HOSTS) hosts.add(host);
		for (const suffix of DEFAULT_MODEL_HOST_SUFFIXES) hosts.add(suffix);
		const deepseekBase = process.env.DEEPSEEK_BASE_URL;
		if (deepseekBase !== void 0 && deepseekBase.length > 0) try {
			hosts.add(hostnameOf(deepseekBase));
		} catch {}
		for (const gateway of piAiGateways(ctx)) try {
			hosts.add(hostnameOf(gateway));
		} catch {}
	}
	const exclude = /* @__PURE__ */ new Set();
	for (const host of config.excludeHosts) {
		const normalized = normalizeHostEntry(host);
		if (normalized !== void 0) exclude.add(normalized);
	}
	return {
		hosts,
		exclude
	};
}
/** Whether two hostname sets hold the same hosts (sets are small; order-free compare). */
function sameHostSet(left, right) {
	if (left.size !== right.size) return false;
	for (const host of left) if (!right.has(host)) return false;
	return true;
}
/** Whether two target pairs would route identically. */
function sameTargets(left, right) {
	return sameHostSet(left.hosts, right.hosts) && sameHostSet(left.exclude, right.exclude);
}
/**
* Install the routing wrapper. The configuration is re-read per refresh, so a
* settings change reaches the next request without a restart; an empty `proxy`
* deactivates routing and restores the platform fetch.
* @param ctx - the Cordis context this plugin mounts into.
* @param config - the parsed plugin config; its fields are live references.
*/
function apply(ctx, config) {
	const originalFetch = globalThis.fetch;
	/** The active routing wrapper plus the settings it was built from. */
	let active;
	let disposed = false;
	/**
	* Whether the last refresh saw a configuration that carries nothing: no
	* proxy URL (settings or `DSH_HTTP_PROXY`) and no host entries at all.
	*/
	let vacant = true;
	const deactivate = () => {
		if (active === void 0) return;
		globalThis.fetch = originalFetch;
		const entry = active.entry;
		active = void 0;
		entry.close().catch(() => {});
	};
	/**
	* Take the settings row DSH wrote for this plugin back out of the profile
	* patch.
	*
	* A row that outlives its settings is pure residue: it keeps the profile's
	* `cordis.patch.yml` dirty, and disabling the plugin cannot remove it,
	* because DSH only drops the bundle. Failures are logged, never thrown — a
	* stale row is not worth failing a plugin mount over.
	* @param why - the trigger, for the log line.
	*/
	const scrubProfile = (why) => {
		try {
			const outcome = pruneProxyEntryFromProfile();
			if (outcome.removed) ctx.logger.info("dsh-proxy: removed the %s settings row from the profile patch (%s, %s)", outcome.id ?? "dsh-proxy", why, outcome.file);
		} catch (cause) {
			ctx.logger.warn("dsh-proxy: could not clean the settings row (%s)", cause instanceof Error ? cause.message : String(cause));
		}
	};
	const refresh = () => {
		if (disposed) return;
		const cfg = readConfig(config);
		const proxyUrl = cfg.proxy.length > 0 ? cfg.proxy : process.env.DSH_HTTP_PROXY ?? "";
		// Nothing configured at all — no proxy URL, no routed hosts, no
		// exclusions — means the profile row carries no information, so it goes
		// back out (see `scrubProfile`). A row that still holds settings stays.
		vacant = proxyUrl.length === 0 && cfg.proxyHosts.length === 0 && cfg.excludeHosts.length === 0;
		if (proxyUrl.length === 0) {
			deactivate();
			if (vacant) scrubProfile("no proxy URL and no host entries");
			return;
		}
		const targets = collectProxyHosts(ctx, cfg);
		if (active !== void 0 && active.proxyUrl === proxyUrl && sameTargets(active.targets, targets)) return;
		let entry;
		try {
			assertValid({ proxy: proxyUrl });
			entry = createProxyFetch(proxyUrl);
		} catch (cause) {
			ctx.logger.warn("dsh-proxy: invalid proxy URL \"%s\" (%s); routing stays off", proxyUrl, cause instanceof Error ? cause.message : String(cause));
			deactivate();
			return;
		}
		const next = {
			proxyUrl,
			targets,
			entry
		};
		const previous = active;
		active = next;
		globalThis.fetch = createRoutingFetch(entry.fetch, originalFetch, targets.hosts, targets.exclude);
		if (previous !== void 0) previous.entry.close().catch(() => {});
	};
	refresh();
	ctx.effect(() => () => {
		disposed = true;
		deactivate();
		// Turning the plugin off (disable, uninstall, or a profile recomposition)
		// leaves nothing behind when the configuration was already empty. With
		// settings still in place the row stays, so mounting the plugin again
		// restores them.
		if (vacant) scrubProfile("plugin unloaded with empty settings");
	});
	ctx.on("loader/volatile-update", () => {
		refresh();
	});
}
//#endregion
export { PROFILE_PATCH_FILE, PROXY_ENTRY_ID, PROXY_IDENTITIES, PROXY_PACKAGE_NAME, profilePatchPath, pruneProxyEntry, pruneProxyEntryFromProfile } from "./profile-patch.js";
export { Config, DEFAULT_DEEPSEEK_HOST, DEFAULT_MODEL_HOSTS, DEFAULT_MODEL_HOST_SUFFIXES, SUPPORTED_PROXY_SCHEMES, apply, assertValid, createProxyFetch, createRoutingFetch, hostnameOf, matchesHostEntry, name, normalizeHostEntry, readConfig, shouldProxy, urlOf };
