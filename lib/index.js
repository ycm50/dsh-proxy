import { PROFILE_MANIFEST_FILE, PROFILE_PATCH_FILE, PROXY_ENTRY_ID, PROXY_IDENTITIES, PROXY_PACKAGE_NAME, planRowCleanup, profileDir, profileManifestPath, profilePatchPath, pruneProxyEntry, pruneProxyEntryFromProfile, readBundleSelection, readProxyEntryState, stripProxyEntryConfig, stripProxyEntryConfigFromProfile } from "./profile-patch.js";
import z from "@deepseek-ai/schemastery";
import { ProxyAgent, fetch } from "undici";
import { execFileSync } from "node:child_process";
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
	excludeHosts: z.array(z.string()).default([]).volatile(),
	useSystemProxy: z.boolean().default(false).volatile()
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
		excludeHosts: hostList(config.excludeHosts.get()),
		useSystemProxy: config.useSystemProxy.get() === true
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
//#region src/rpc-contract.ts
/**
* The wire this plugin's two halves share for "read the operating system's
* proxy" requests: the Connection channel and endpoint it serves, and the
* result shape both sides agree on.
*
* Leaf module on purpose — the Host half registers the route and the browser
* half calls it, and pointing either at the other would make the browser
* bundle pull in the Host half's `node:` imports. Nothing here may import
* `node:*` or any package.
* @module dsh-proxy/rpc-contract
*/
/**
* The Connection channel this plugin's endpoint lives on.
*
* It is Connection's shared browser carrier, not a channel of our own:
* Connection registers one web-server prefix per channel, and the registry
* its own service exposes can only add an exact Fetch route *under* `/api`.
* The channel brings the Host/Origin fence and browser authentication with it,
* which is why the endpoint does not have to implement either.
*/
const SYSTEM_PROXY_CHANNEL = "/api";
/**
* The endpoint this plugin serves on {@link SYSTEM_PROXY_CHANNEL}.
*
* Connection's own callers spell an endpoint as `<namespace>/<method>`, and a
* route path is the channel plus that endpoint, so the browser reaches this
* plugin at `/api/dsh-proxy/system-proxy`.
*/
const SYSTEM_PROXY_ENDPOINT = "dsh-proxy/system-proxy";
/** The exact web-server path of this plugin's endpoint. */
const SYSTEM_PROXY_ROUTE = `${SYSTEM_PROXY_CHANNEL}/${SYSTEM_PROXY_ENDPOINT}`;
//#endregion
//#region src/system-proxy.ts
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
/** The per-user WinINET key Windows keeps its proxy settings in. */
const WINDOWS_INTERNET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
/** Environment variables consulted, in priority order. */
const PROXY_ENV_NAMES = [
	"HTTPS_PROXY",
	"https_proxy",
	"HTTP_PROXY",
	"http_proxy",
	"ALL_PROXY",
	"all_proxy"
];
/** How long one probe may take before the reading gives up on it. */
const PROBE_TIMEOUT_MS = 5e3;
/**
* Run one probe program and read its output.
*
* Any failure — a missing binary, an exit status, the timeout, a refused pipe —
* is an absent answer, never an exception: a machine with no `reg.exe` still
* gets a reading (from the environment variables).
*/
function probe(file, args) {
	try {
		return execFileSync(file, args, {
			encoding: "latin1",
			timeout: PROBE_TIMEOUT_MS,
			windowsHide: true,
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			]
		});
	} catch {
		return;
	}
}
/** Compose a reading, leaving `pacUrl` off entirely when there is none. */
function reading(fields, pacUrl) {
	return pacUrl === void 0 || pacUrl.length === 0 ? fields : {
		...fields,
		pacUrl
	};
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
function normalizeProxyValue(value) {
	const trimmed = value.trim();
	if (trimmed.length === 0) return void 0;
	const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
	let parsed;
	try {
		parsed = new URL(candidate);
	} catch {
		return;
	}
	const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
	if (!SUPPORTED_PROXY_SCHEMES.includes(scheme)) return void 0;
	if (parsed.hostname.length === 0) return void 0;
	return `${scheme}://${parsed.username.length > 0 ? `${parsed.username}${parsed.password.length > 0 ? `:${parsed.password}` : ""}@` : ""}${parsed.host}`;
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
function parseWindowsProxyServer(value) {
	const entries = [];
	for (const part of value.split(";")) {
		const trimmed = part.trim();
		if (trimmed.length === 0) continue;
		const separator = trimmed.indexOf("=");
		const target = separator === -1 ? void 0 : trimmed.slice(0, separator).trim().toLowerCase();
		const raw = separator === -1 ? trimmed : trimmed.slice(separator + 1).trim();
		const bare = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
		const url = target === "socks" && !bare ? normalizeProxyValue(`socks5://${raw}`) : normalizeProxyValue(raw);
		if (url === void 0) continue;
		entries.push(target === void 0 ? { url } : {
			target,
			url
		});
	}
	return entries;
}
/**
* Target-protocol priority for a per-protocol `ProxyServer` value: the model
* requests this plugin routes are HTTPS, so the `https` entry is the one that
* speaks to them; a shared entry covers everything at once.
*/
const WINDOWS_TARGET_PRIORITY = [
	"https",
	"http",
	void 0,
	"socks"
];
/**
* Pick the entry to route with.
* @param entries - parsed `ProxyServer` entries.
* @returns the preferred entry, or undefined when there is none.
*/
function pickWindowsProxy(entries) {
	for (const target of WINDOWS_TARGET_PRIORITY) {
		const match = entries.find((entry) => entry.target === target);
		if (match !== void 0) return match;
	}
	return entries[0];
}
/**
* Parse `reg query` output for the WinINET key.
* @param stdout - the command's output.
* @returns the four values, with absent ones left at their resting state.
*/
function parseWindowsRegistry(stdout) {
	const values = /* @__PURE__ */ new Map();
	for (const line of stdout.split(/\r?\n/)) {
		const match = /^\s+(\S+)\s+REG_[A-Z_]+\s+(.*)$/.exec(line);
		if (match === null) continue;
		const name = match[1];
		const data = match[2];
		if (name === void 0 || data === void 0) continue;
		values.set(name.toLowerCase(), data.trim());
	}
	const enabled = (name) => {
		const data = values.get(name);
		if (data === void 0) return false;
		return Number.parseInt(data.replace(/^0x/i, ""), 16) !== 0;
	};
	return {
		enable: enabled("proxyenable"),
		server: values.get("proxyserver") ?? "",
		pacUrl: values.get("autoconfigurl") ?? "",
		autoDetect: enabled("autodetect")
	};
}
/**
* Read Windows' proxy configuration.
* @returns the reading, or undefined when the registry could not be queried.
*/
function readWindowsSystemProxy() {
	const stdout = probe("reg.exe", ["query", WINDOWS_INTERNET_SETTINGS_KEY]);
	if (stdout === void 0) return void 0;
	const registry = parseWindowsRegistry(stdout);
	const base = {
		source: "windows-registry",
		platform: "win32"
	};
	if (!registry.enable || registry.server.length === 0) {
		const detail = registry.pacUrl.length > 0 ? `Windows Internet Settings use the auto-config script ${registry.pacUrl}` : registry.autoDetect ? "Windows Internet Settings enable automatic proxy detection" : "Windows Internet Settings declare no proxy";
		return reading({
			...base,
			proxy: "",
			detail
		}, registry.pacUrl);
	}
	const chosen = pickWindowsProxy(parseWindowsProxyServer(registry.server));
	if (chosen === void 0) return reading({
		...base,
		proxy: "",
		detail: `Windows Internet Settings declare "${registry.server}", which is not a usable proxy URL`
	}, registry.pacUrl);
	return reading({
		...base,
		proxy: chosen.url,
		detail: `Windows Internet Settings: ${registry.server}`
	}, registry.pacUrl);
}
/**
* Parse `scutil --proxy` output.
* @param stdout - the command's output.
* @returns the preferred proxy and a summary.
*/
function parseScutilProxy(stdout) {
	const values = /* @__PURE__ */ new Map();
	for (const line of stdout.split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator === -1) continue;
		values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
	}
	for (const candidate of [
		{
			enable: "HTTPSEnable",
			host: "HTTPSProxy",
			port: "HTTPSPort",
			scheme: "http"
		},
		{
			enable: "HTTPEnable",
			host: "HTTPProxy",
			port: "HTTPPort",
			scheme: "http"
		},
		{
			enable: "SOCKSEnable",
			host: "SOCKSProxy",
			port: "SOCKSPort",
			scheme: "socks5"
		}
	]) {
		if ((values.get(candidate.enable) ?? "0") !== "1") continue;
		const host = values.get(candidate.host) ?? "";
		if (host.length === 0) continue;
		const port = values.get(candidate.port) ?? "";
		const url = normalizeProxyValue(`${candidate.scheme}://${host}${port.length > 0 ? `:${port}` : ""}`);
		if (url === void 0) continue;
		return {
			proxy: url,
			detail: `macOS system proxy: ${host}:${port}`
		};
	}
	const pac = values.get("ProxyAutoConfigURLString") ?? "";
	return pac.length > 0 ? {
		proxy: "",
		detail: `macOS uses the auto-config script ${pac}`,
		pacUrl: pac
	} : {
		proxy: "",
		detail: "macOS declares no proxy"
	};
}
/**
* Read macOS' proxy configuration.
* @returns the reading, or undefined when `scutil` could not be queried.
*/
function readMacSystemProxy() {
	const stdout = probe("scutil", ["--proxy"]);
	if (stdout === void 0) return void 0;
	const parsed = parseScutilProxy(stdout);
	return reading({
		proxy: parsed.proxy,
		source: "macos-scutil",
		detail: parsed.detail,
		platform: "darwin"
	}, parsed.pacUrl);
}
/**
* Read a GSettings value: the CLI prints strings single-quoted.
* @param output - the command's output.
* @returns the value without the command's quoting.
*/
function parseGsettingsValue(output) {
	const trimmed = output.trim();
	return trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'") ? trimmed.slice(1, -1) : trimmed;
}
/**
* Read Linux' proxy configuration from the GNOME proxy GSettings.
* @returns the reading; a desktop without those schemas reads as "no proxy".
*/
function readLinuxSystemProxy() {
	const base = {
		source: "linux-gsettings",
		platform: "linux"
	};
	const modeOutput = probe("gsettings", [
		"get",
		"org.gnome.system.proxy",
		"mode"
	]);
	if (modeOutput === void 0) return reading({
		...base,
		proxy: "",
		detail: "no GSettings proxy configuration is readable"
	}, void 0);
	const mode = parseGsettingsValue(modeOutput);
	if (mode !== "manual") return reading({
		...base,
		proxy: "",
		detail: `GSettings proxy mode is "${mode}"`
	}, void 0);
	for (const scheme of [
		"https",
		"http",
		"socks"
	]) {
		const hostOutput = probe("gsettings", [
			"get",
			`org.gnome.system.proxy.${scheme}`,
			"host"
		]);
		if (hostOutput === void 0) continue;
		const host = parseGsettingsValue(hostOutput);
		if (host.length === 0) continue;
		const portOutput = probe("gsettings", [
			"get",
			`org.gnome.system.proxy.${scheme}`,
			"port"
		]);
		const port = portOutput === void 0 ? "" : parseGsettingsValue(portOutput);
		const url = normalizeProxyValue(`${scheme === "socks" ? `socks5://${host}` : `http://${host}`}${Number(port) > 0 ? `:${port}` : ""}`);
		if (url === void 0) continue;
		return reading({
			...base,
			proxy: url,
			detail: `GSettings ${scheme} proxy: ${host}:${port}`
		}, void 0);
	}
	return reading({
		...base,
		proxy: "",
		detail: "GSettings manual mode declares no host"
	}, void 0);
}
/**
* Read the proxy from the environment.
* @param env - the environment to read (injectable for tests).
* @returns the first usable proxy plus the variable it came from, or undefined.
*/
function readEnvironmentProxy(env) {
	for (const name of PROXY_ENV_NAMES) {
		const value = env[name];
		if (value === void 0 || value.trim().length === 0) continue;
		const url = normalizeProxyValue(value);
		if (url === void 0) continue;
		return {
			proxy: url,
			detail: `environment variable ${name}`
		};
	}
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
function readSystemProxy(options = {}) {
	const platform = options.platform ?? process.platform;
	const native = platform === "win32" ? readWindowsSystemProxy() : platform === "darwin" ? readMacSystemProxy() : platform === "linux" ? readLinuxSystemProxy() : void 0;
	if (native !== void 0 && native.proxy.length > 0) return native;
	const fromEnv = readEnvironmentProxy(options.env ?? process.env);
	if (fromEnv !== void 0) return reading({
		proxy: fromEnv.proxy,
		source: "env",
		detail: fromEnv.detail,
		platform
	}, void 0);
	if (native !== void 0) return native;
	return reading({
		proxy: "",
		source: "none",
		detail: "no system proxy configuration was found",
		platform
	}, void 0);
}
//#endregion
//#region src/rpc.ts
/** The correlation id Connection itself uses when a request cannot be parsed. */
const INVALID_RPC_ID = "invalid-request";
/**
* Build one failure answer.
* @param code - stable machine-readable code.
* @param message - human-readable message.
* @param details - extra structured detail.
* @returns the failure in the envelope shape.
*/
function fail(code, message, details = {}) {
	return {
		ok: false,
		error: {
			code,
			message,
			details
		}
	};
}
/**
* Wrap one result in the response envelope Connection's browser caller parses.
* @param rpcId - the request's correlation id.
* @param result - the endpoint's answer.
* @returns the JSON response.
*/
function respond(rpcId, result) {
	return Response.json({
		type: "server-response",
		rpcId,
		result
	});
}
/**
* Answer one call to this plugin's endpoint.
* @param request - the buffered request Connection hands over.
* @returns the response envelope.
*/
async function answer(request) {
	let body;
	try {
		body = await request.json();
	} catch {
		return respond(INVALID_RPC_ID, fail("dsh-proxy/bad-request", "the request body is not JSON"));
	}
	const envelope = typeof body === "object" && body !== null ? body : {};
	const rpcId = typeof envelope.rpcId === "string" ? envelope.rpcId : INVALID_RPC_ID;
	if (envelope.type !== "client-request" || envelope.method !== "dsh-proxy/system-proxy") return respond(rpcId, fail("dsh-proxy/unknown-endpoint", `dsh-proxy answers only "${SYSTEM_PROXY_ENDPOINT}" on this route`, { method: typeof envelope.method === "string" ? envelope.method : null }));
	try {
		return respond(rpcId, {
			ok: true,
			value: readSystemProxy()
		});
	} catch (cause) {
		return respond(rpcId, fail("dsh-proxy/system-proxy-failed", cause instanceof Error ? cause.message : String(cause)));
	}
}
/**
* Serve {@link SYSTEM_PROXY_ROUTE} on Connection's browser carrier.
*
* The registration follows the `connection` service: it is installed when the
* service appears and withdrawn with this plugin's fiber.
* @param ctx - the Host plugin context to hang the route under.
*/
function installSystemProxyRpc(ctx) {
	ctx.inject(["connection"], (connectionCtx) => {
		const routes = connectionCtx.get("connection")?.fetch;
		if (routes === void 0) return;
		let dispose;
		try {
			dispose = routes.register({
				path: SYSTEM_PROXY_ROUTE,
				methods: ["POST"],
				requestBody: "buffered",
				fetch: answer
			});
		} catch (cause) {
			connectionCtx.logger.warn("dsh-proxy: cannot serve %s (%s); the settings page will not be able to read the system proxy", SYSTEM_PROXY_ROUTE, cause instanceof Error ? cause.message : String(cause));
			return;
		}
		connectionCtx.effect(() => () => {
			dispose?.();
		});
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
* Install the routing wrapper, and the Connection channel that lets the
* settings page read this machine's proxy. The configuration is re-read per
* refresh, so a settings change reaches the next request without a restart; an
* empty `proxy` deactivates routing and restores the platform fetch, and
* `useSystemProxy` exchanges the typed address for the machine's own.
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
	* proxy URL (settings, the system, or `DSH_HTTP_PROXY`), no host entries, and
	* no system-proxy switch.
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
	/**
	* Take this plugin's settings out of the profile patch, leaving the row and
	* its other keys in place.
	*
	* This is what a switch-off through DSH's per-entry key gets: the row must
	* stay, because it carries the `disabled: true` that keeps the entry off, and
	* only its `config` goes (see `stripProxyEntryConfig`).
	* @param why - the trigger, for the log line.
	*/
	const stripSettings = (why) => {
		try {
			const outcome = stripProxyEntryConfigFromProfile();
			if (outcome.removed) ctx.logger.info("dsh-proxy: took the %s settings out of the profile patch, keeping its disabled marker (%s, %s)", outcome.id ?? "dsh-proxy", why, outcome.file);
		} catch (cause) {
			ctx.logger.warn("dsh-proxy: could not clear the settings in the profile patch (%s)", cause instanceof Error ? cause.message : String(cause));
		}
	};
	/**
	* The last system-proxy outcome this instance logged, so a settings edit
	* that does not move the reading does not repeat the line.
	*/
	let lastSystemReport = "";
	/**
	* Log what the machine's proxy turned out to be, once per distinct outcome.
	* @param system - the reading.
	* @param active - the proxy URL routing actually uses after fallbacks.
	*/
	const reportSystemProxy = (system, active) => {
		const report = `${system.source}|${system.proxy}|${active}`;
		if (report === lastSystemReport) return;
		lastSystemReport = report;
		if (system.proxy.length > 0) ctx.logger.info("dsh-proxy: using the system proxy %s (%s)", system.proxy, system.detail);
		else if (active.length > 0) ctx.logger.info("dsh-proxy: no system proxy was found (%s); using %s", system.detail, active);
		else ctx.logger.warn("dsh-proxy: the system proxy was requested but none was found (%s); routing stays off", system.detail);
	};
	/**
	* Run the profile cleanup the current state calls for, if any.
	*
	* Both moments that clean the profile — the settings becoming empty while the
	* plugin runs, and the fiber unloading — ask {@link planRowCleanup} first,
	* because deleting a row DSH marked `disabled: true` would re-enable the
	* entry its bundle inserts.
	* @param trigger - where the cleanup came from, for the log line.
	*/
	const cleanProfileIfOff = (trigger) => {
		let plan;
		try {
			plan = planRowCleanup(vacant);
		} catch (cause) {
			ctx.logger.warn("dsh-proxy: could not read the profile (%s)", cause instanceof Error ? cause.message : String(cause));
			return;
		}
		if (plan === void 0) return;
		if (plan.mode === "remove") scrubProfile(`${trigger}: ${plan.reason}`);
		else stripSettings(`${trigger}: ${plan.reason}`);
	};
	const refresh = () => {
		if (disposed) return;
		const cfg = readConfig(config);
		const system = cfg.useSystemProxy ? readSystemProxy() : void 0;
		const detected = system?.proxy ?? "";
		const proxyUrl = detected.length > 0 ? detected : cfg.proxy.length > 0 ? cfg.proxy : process.env.DSH_HTTP_PROXY ?? "";
		if (system !== void 0) reportSystemProxy(system, proxyUrl);
		vacant = proxyUrl.length === 0 && cfg.proxyHosts.length === 0 && cfg.excludeHosts.length === 0 && !cfg.useSystemProxy;
		if (proxyUrl.length === 0) {
			deactivate();
			if (vacant) cleanProfileIfOff("cleared settings");
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
	installSystemProxyRpc(ctx);
	ctx.effect(() => () => {
		disposed = true;
		deactivate();
		cleanProfileIfOff("plugin unloaded");
	});
	ctx.on("loader/volatile-update", () => {
		refresh();
	});
}
//#endregion
export { Config, DEFAULT_DEEPSEEK_HOST, DEFAULT_MODEL_HOSTS, DEFAULT_MODEL_HOST_SUFFIXES, PROFILE_MANIFEST_FILE, PROFILE_PATCH_FILE, PROXY_ENTRY_ID, PROXY_ENV_NAMES, PROXY_IDENTITIES, PROXY_PACKAGE_NAME, SUPPORTED_PROXY_SCHEMES, SYSTEM_PROXY_CHANNEL, SYSTEM_PROXY_ENDPOINT, SYSTEM_PROXY_ROUTE, WINDOWS_INTERNET_SETTINGS_KEY, apply, assertValid, createProxyFetch, createRoutingFetch, hostnameOf, installSystemProxyRpc, matchesHostEntry, name, normalizeHostEntry, normalizeProxyValue, parseGsettingsValue, parseScutilProxy, parseWindowsProxyServer, parseWindowsRegistry, pickWindowsProxy, planRowCleanup, profileDir, profileManifestPath, profilePatchPath, pruneProxyEntry, pruneProxyEntryFromProfile, readBundleSelection, readConfig, readEnvironmentProxy, readMacSystemProxy, readProxyEntryState, readSystemProxy, readWindowsSystemProxy, shouldProxy, stripProxyEntryConfig, stripProxyEntryConfigFromProfile, urlOf };
