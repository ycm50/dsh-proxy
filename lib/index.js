import { PROFILE_MANIFEST_FILE, PROFILE_PATCH_FILE, PROXY_ENTRY_ID, PROXY_IDENTITIES, PROXY_PACKAGE_NAME, planRowCleanup, profileDir, profileManifestPath, profilePatchPath, pruneProxyEntry, pruneProxyEntryFromProfile, readBundleSelection, readProxyEntryState, stripProxyEntryConfig, stripProxyEntryConfigFromProfile } from "./profile-patch.js";
import z from "@deepseek-ai/schemastery";
import { Agent, Dispatcher, ProxyAgent, fetch, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { execFileSync } from "node:child_process";
//#region src/stability.ts
/** Field names, in the order the settings page shows them. */
const STABILITY_FIELDS = [
	"connectTimeoutMs",
	"responseTimeoutMs",
	"streamIdleTimeoutMs",
	"retryCount",
	"retryDelayMs",
	"retryOnPossibleDelivery"
];
/**
* Defaults.
*
* `connectTimeoutMs` is the one that matters most for a slow gateway: 60 s
* clears the measured 10.5 s proxy CONNECT with room for a bad minute, where
* undici's 10 s turned the same request into UND_ERR_CONNECT_TIMEOUT.
* `responseTimeoutMs` keeps undici's own 5 minutes. `streamIdleTimeoutMs`
* is off, so a model that thinks for a while before its next chunk is never
* cut off here — the harness has its own stream watchdog for that.
*/
const DEFAULT_STABILITY = {
	connectTimeoutMs: 6e4,
	responseTimeoutMs: 3e5,
	streamIdleTimeoutMs: 0,
	retryCount: 3,
	retryDelayMs: 400,
	retryOnPossibleDelivery: true
};
/** Inclusive bounds per numeric field; a value outside is clamped, never rejected. */
const STABILITY_BOUNDS = {
	connectTimeoutMs: {
		min: 1e3,
		max: 6e5
	},
	responseTimeoutMs: {
		min: 0,
		max: 36e5
	},
	streamIdleTimeoutMs: {
		min: 0,
		max: 36e5
	},
	retryCount: {
		min: 0,
		max: 10
	},
	retryDelayMs: {
		min: 50,
		max: 1e4
	}
};
/**
* Read one numeric field out of raw configuration: a finite integer in range
* is taken as-is (clamped when it falls outside), anything else falls back to
* the default. Both repairs are reported, because a silently ignored setting
* is worse than a loud one.
* @param field - the field being read.
* @param raw - the stored value, of unknown shape.
* @param warn - where a repair is reported.
* @returns the effective value.
*/
function stabilizeNumber(field, raw, warn) {
	const fallback = DEFAULT_STABILITY[field];
	const bounds = STABILITY_BOUNDS[field];
	if (raw === void 0 || raw === null) return fallback;
	const numeric = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(numeric)) {
		warn?.("dsh-proxy: " + field + " is not a number; using " + String(fallback));
		return fallback;
	}
	const rounded = Math.round(numeric);
	if (rounded < bounds.min || rounded > bounds.max) {
		const clamped = Math.min(bounds.max, Math.max(bounds.min, rounded));
		warn?.("dsh-proxy: " + field + " " + String(rounded) + "ms is outside " + String(bounds.min) + "-" + String(bounds.max) + "; using " + String(clamped));
		return clamped;
	}
	return rounded;
}
/**
* Turn one raw configuration object into effective stability settings.
* @param raw - stored values; absent fields take their defaults.
* @param warn - where a repaired value is reported.
* @returns the effective settings.
*/
function readStability(raw, warn) {
	const source = raw ?? {};
	return {
		connectTimeoutMs: stabilizeNumber("connectTimeoutMs", source.connectTimeoutMs, warn),
		responseTimeoutMs: stabilizeNumber("responseTimeoutMs", source.responseTimeoutMs, warn),
		streamIdleTimeoutMs: stabilizeNumber("streamIdleTimeoutMs", source.streamIdleTimeoutMs, warn),
		retryCount: stabilizeNumber("retryCount", source.retryCount, warn),
		retryDelayMs: stabilizeNumber("retryDelayMs", source.retryDelayMs, warn),
		retryOnPossibleDelivery: source.retryOnPossibleDelivery === void 0 ? DEFAULT_STABILITY.retryOnPossibleDelivery : source.retryOnPossibleDelivery === true
	};
}
/** Whether the settings carry anything away from the shipped defaults. */
function stabilityIsDefault(stability) {
	for (const field of STABILITY_FIELDS) if (stability[field] !== DEFAULT_STABILITY[field]) return false;
	return true;
}
/**
* The pooled-idle window this plugin allows, in milliseconds.
*
* Deliberately far below undici's 600 s default: a socket that has sat idle for
* minutes is exactly the one a carrier NAT, a proxy, or the peer itself has
* already dropped, and reusing it is how "Connection error." and "terminated"
* appear on a request that a fresh connection would have served. 60 s of idle
* costs one extra handshake after a long pause and removes that class.
*/
const POOLED_IDLE_WINDOW_MS = 6e4;
/** How long an accepted socket may sit before its first keepalive probe. */
const TCP_KEEPALIVE_DELAY_MS = 3e4;
/**
* Translate stability settings into agent options.
*
* Two settings carry most of the weight. `connectTimeout` (and the matching
* `connect.timeout`, which is what a proxy CONNECT is bounded by) is the
* ceiling that stops a slow handshake from being read as an unreachable host.
* `connect.keepAlive` with a 30 s first probe makes a black-holed
* connection fail at the TCP level in about a minute instead of letting a
* request wait out the SDK's ten-minute deadline.
* @param stability - the effective settings.
* @returns options for an undici Agent or ProxyAgent.
*/
function agentOptionsOf(stability) {
	return {
		connectTimeout: stability.connectTimeoutMs,
		headersTimeout: stability.responseTimeoutMs,
		bodyTimeout: stability.streamIdleTimeoutMs,
		keepAliveTimeout: 1e4,
		keepAliveMaxTimeout: POOLED_IDLE_WINDOW_MS,
		keepAliveTimeoutThreshold: 1e3,
		pipelining: 1,
		maxRedirections: 0,
		connect: {
			timeout: stability.connectTimeoutMs,
			keepAlive: true,
			keepAliveInitialDelay: TCP_KEEPALIVE_DELAY_MS,
			autoSelectFamily: true,
			autoSelectFamilyAttemptTimeout: 2500
		}
	};
}
/** One short line for the mount log, so the effective budget is never a guess. */
function describeStability(stability) {
	const seconds = (ms) => ms === 0 ? "off" : String(Math.round(ms / 1e3)) + "s";
	return "connect=" + seconds(stability.connectTimeoutMs) + " headers=" + seconds(stability.responseTimeoutMs) + " body=" + seconds(stability.streamIdleTimeoutMs) + " retry=" + String(stability.retryCount) + "x" + String(stability.retryDelayMs) + "ms" + (stability.retryOnPossibleDelivery ? "" : " retry-safe-only");
}
//#endregion
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
	useSystemProxy: z.boolean().default(false).volatile(),
	proxySubprocesses: z.boolean().default(false).volatile(),
	connectTimeoutMs: z.natural().default(DEFAULT_STABILITY.connectTimeoutMs).volatile(),
	responseTimeoutMs: z.natural().default(DEFAULT_STABILITY.responseTimeoutMs).volatile(),
	streamIdleTimeoutMs: z.natural().default(DEFAULT_STABILITY.streamIdleTimeoutMs).volatile(),
	retryCount: z.natural().default(DEFAULT_STABILITY.retryCount).volatile(),
	retryDelayMs: z.natural().default(DEFAULT_STABILITY.retryDelayMs).volatile(),
	retryOnPossibleDelivery: z.boolean().default(DEFAULT_STABILITY.retryOnPossibleDelivery).volatile()
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
function readConfig(config, warn) {
	const proxy = readRef(config.proxy);
	return {
		proxy: typeof proxy === "string" ? proxy : "",
		proxyHosts: hostList(readRef(config.proxyHosts)),
		excludeHosts: hostList(readRef(config.excludeHosts)),
		useSystemProxy: readRef(config.useSystemProxy) === true,
		proxySubprocesses: readRef(config.proxySubprocesses) === true,
		stability: readStability({
			connectTimeoutMs: readRef(config.connectTimeoutMs),
			responseTimeoutMs: readRef(config.responseTimeoutMs),
			streamIdleTimeoutMs: readRef(config.streamIdleTimeoutMs),
			retryCount: readRef(config.retryCount),
			retryDelayMs: readRef(config.retryDelayMs),
			retryOnPossibleDelivery: readRef(config.retryOnPossibleDelivery)
		}, warn)
	};
}
/**
* Read one volatile reference without trusting its shape.
*
* The Loader always hands over the schema's references, but this plugin can be
* mounted from a context that predates a field — an older profile, a test, or
* another package composing it. Reading an absent field as "absent" gives the
* caller the shipped default, where a bare `.get()` call would throw from
* inside the request path.
* @param ref - the stored reference, a plain value, or nothing.
* @returns the current value, or undefined when there is nothing to read.
*/
function readRef(ref) {
	if (ref === void 0 || ref === null) return void 0;
	const candidate = ref;
	if (typeof candidate.get === "function") return candidate.get();
	return ref;
}
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
const SUBPROCESS_PROXY_SCHEMES = ["http", "https"];
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
function isValidSubprocessProxy(value) {
	if (value === void 0) return false;
	const trimmed = value.trim();
	if (trimmed.length === 0) return false;
	let parsed;
	try {
		parsed = new URL(trimmed);
	} catch {
		return false;
	}
	return SUBPROCESS_PROXY_SCHEMES.includes(parsed.protocol.replace(/:$/, ""));
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
/**
* One IPv4 octet, so a private-range match cannot accept \`10.999.1.1\`.
*/
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
/**
* The private, link-local, carrier-grade-NAT, and unspecified IPv4 blocks.
*
* These are the "physical space" this plugin must never route: a LAN service
* (a local model server, an MCP endpoint on another machine, a router admin
* page) reached through a forward proxy either fails outright or — worse —
* travels out to a provider and back. The same reasoning that keeps loopback
* direct keeps these direct, so the exemption is built in and cannot be
* overridden by a host list.
*/
const PRIVATE_IPV4 = [
	new RegExp("^10\\." + OCTET + "\\." + OCTET + "\\." + OCTET + "$"),
	new RegExp("^192\\.168\\." + OCTET + "\\." + OCTET + "$"),
	new RegExp("^172\\.(?:1[6-9]|2\\d|3[01])\\." + OCTET + "\\." + OCTET + "$"),
	new RegExp("^169\\.254\\." + OCTET + "\\." + OCTET + "$"),
	new RegExp("^100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\." + OCTET + "\\." + OCTET + "$"),
	new RegExp("^0\\." + OCTET + "\\." + OCTET + "\\." + OCTET + "$")
];
/** Single-label and reserved suffixes that name a local network, never a public endpoint. */
const LOCAL_SUFFIXES = [
	".local",
	".localdomain",
	".lan",
	".internal",
	".home.arpa",
	".localhost"
];
/**
* Whether a hostname names a private/local network rather than the public
* internet. Pure string comparison, never DNS — the decision must not depend
* on the network being reachable (see \`isLoopbackHostname\` for the same rule).
*
* Covered: \`10/8\`, \`172.16/12\`, \`192.168/16\`, \`169.254/16\`, \`100.64/10\`,
* \`0/8\`; IPv6 unique-local \`fc00::/7\` and link-local \`fe80::/10\` (including the
* IPv4-mapped spellings Node's \`URL\` may hand over); and the local suffixes
* above.
* @param hostname - a URL hostname, bracketed or not, in any case.
* @returns whether the host is a private/local address.
*/
function isLanHostname(hostname) {
	let host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
	if (host.length === 0) return false;
	if (host.startsWith("::ffff:")) host = host.slice(7);
	if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
	if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
	for (const suffix of LOCAL_SUFFIXES) if (host.endsWith(suffix)) return true;
	if (host.indexOf(".") === -1 && host.indexOf(":") === -1) return true;
	for (const pattern of PRIVATE_IPV4) if (pattern.test(host)) return true;
	return false;
}
//#endregion
//#region src/retry.ts
/**
* Transport-level retry: the innermost of the three retry layers a model
* request passes through.
*
* The harness retries whole requests (dsh-llm-retry) and the SDK layer is
* configured not to retry at all, so a connection failure that is pure bad luck
* — a SYN that a flaky route dropped, a pooled socket the peer had already
* closed — used to consume one whole harness attempt. This layer re-dials
* immediately, before the failure is ever visible upstairs, which is what turns
* "four retries all failed" into "one request succeeded".
*
* Safety rules, in order of importance:
*   - A request whose body cannot be replayed is sent exactly once. A stream or
*     an async iterable cannot be re-read, so retrying it would send a truncated
*     body.
*   - A caller's abort is never retried, and the backoff sleep is interruptible,
*     so pressing Stop is immediate.
*   - Only connection-level failures qualify. An HTTP status is a response, not
*     a transport failure, and belongs to the harness's own policy.
*   - A reset that may have arrived after the request was delivered is retried
*     only when the configuration says so (retryOnPossibleDelivery), because
*     for a non-idempotent request that costs a duplicate.
* @module dsh-proxy/retry
*/
/** Failures that prove nothing was delivered: retrying cannot duplicate work. */
const NOT_DELIVERED = /* @__PURE__ */ new Set([
	"ECONNREFUSED",
	"UND_ERR_CONNECT_TIMEOUT",
	"EAI_AGAIN",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"ENETDOWN",
	"EHOSTDOWN"
]);
/** Failures where the request may already have reached the peer. */
const POSSIBLY_DELIVERED = /* @__PURE__ */ new Set([
	"ECONNRESET",
	"EPIPE",
	"ETIMEDOUT",
	"UND_ERR_SOCKET"
]);
/** The transport code carried by a fetch failure, if any. */
function transportCodeOf(error) {
	const candidate = error;
	const fromCause = candidate?.cause?.code;
	if (typeof fromCause === "string") return fromCause;
	const direct = candidate?.code;
	if (typeof direct === "string") return direct;
	return "";
}
/**
* Whether a failure is a connection-level failure this layer may retry.
* @param error - the rejection from a fetch call.
* @param retryOnPossibleDelivery - whether possibly-delivered failures qualify.
* @returns whether to try again.
*/
function isRetryableTransportError(error, retryOnPossibleDelivery = true) {
	const code = transportCodeOf(error);
	if (code.length === 0) return false;
	if (NOT_DELIVERED.has(code)) return true;
	return retryOnPossibleDelivery && POSSIBLY_DELIVERED.has(code);
}
/** A URL string for a log line, without importing the routing module back. */
function urlOfInput(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	const request = input;
	return typeof request?.url === "string" ? request.url : "";
}
/**
* Whether a request body can be sent a second time.
*
* Everything undici accepts as a replayable body is listed explicitly; a
* `ReadableStream`, an async iterable, or anything unrecognised is not, so
* `duplex: 'half'` and stream bodies are one-shot by construction.
* @param init - the fetch init that accompanied the request.
* @returns whether a retry may resend the same body.
*/
function isReplayableRequest(init) {
	if (init === void 0) return true;
	if (init.duplex === "half") return false;
	const body = init.body;
	if (body === void 0 || body === null) return true;
	if (typeof body === "string") return true;
	if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return true;
	if (ArrayBuffer.isView(body)) return true;
	if (body instanceof ArrayBuffer) return true;
	if (typeof Blob !== "undefined" && body instanceof Blob) return true;
	if (typeof FormData !== "undefined" && body instanceof FormData) return true;
	return false;
}
/**
* Whether a signal has already fired.
*
* A function rather than an inline comparison on purpose: the value changes
* across an `await`, which control-flow analysis cannot see, so a direct
* comparison after an earlier check would be narrowed away by the compiler.
* @param signal - the request's abort signal, if any.
* @returns whether the caller already cancelled.
*/
function isAborted(signal) {
	return signal !== null && signal !== void 0 && signal.aborted === true;
}
/** Sleep that a caller's abort can cut short, so Stop stays immediate. */
function abortableSleep(ms, signal) {
	return new Promise((resolve) => {
		if (signal?.aborted === true || ms <= 0) {
			resolve();
			return;
		}
		const finish = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal?.addEventListener("abort", finish, { once: true });
	});
}
/**
* Wrap a fetch so connection-level failures are re-dialled.
*
* The returned fetch resolves or rejects exactly like the one it wraps: once
* the attempts are exhausted the original error is rethrown unchanged, so the
* harness sees the transport code it always saw.
* @param fetchImpl - the channel fetch (direct or proxied) to wrap.
* @param policy - retry budget and reporting.
* @returns the retrying fetch, or `fetchImpl` unchanged when retries are off.
*/
function withTransportRetry(fetchImpl, policy) {
	const maxRetries = Number.isFinite(policy.maxRetries) ? Math.max(0, Math.trunc(policy.maxRetries)) : 0;
	if (maxRetries === 0) return fetchImpl;
	const baseDelayMs = Number.isFinite(policy.baseDelayMs) ? Math.max(0, policy.baseDelayMs) : 0;
	const retryOnPossibleDelivery = policy.retryOnPossibleDelivery !== false;
	return (async (input, init) => {
		const signal = init?.signal ?? null;
		const replayable = isReplayableRequest(init);
		let attempt = 0;
		for (;;) try {
			return await fetchImpl(input, init);
		} catch (error) {
			const code = transportCodeOf(error);
			if (!(attempt < maxRetries && replayable && !isAborted(signal) && isRetryableTransportError(error, retryOnPossibleDelivery))) throw error;
			attempt += 1;
			policy.onRetry?.({
				attempt,
				maxRetries,
				code,
				url: urlOfInput(input)
			});
			await abortableSleep(Math.round(baseDelayMs * 2 ** (attempt - 1) * (.75 + Math.random() * .5)), signal);
			if (isAborted(signal)) throw error;
		}
	});
}
//#endregion
//#region src/proxy.ts
/**
* Proxy transport and host-routing helpers for `dsh-proxy`.
*
* The plugin does not touch DeepSeek Harness source. It installs a wrapper
* around `globalThis.fetch` — which both the DeepSeek adapter's raw `fetch` and
* the pi-ai SDK clients call — and routes model-API hosts through a proxy
* dispatcher, leaving every other host on this plugin's own **hardened direct**
* channel. Only the hosts the configuration names are routed; `excludeHosts`
* always stays direct, and loopback and private networks are exempt on top of
* that (see {@link isExemptHostname}).
*
* Both channels are built from the same hardened options (see
* `dsh-proxy/stability`): a long connect ceiling, TCP keepalive, a bounded
* pooled-idle window, and a transport-level retry for connection failures. The
* point of hardening the direct channel too is that "not proxied" must not mean
* "back to undici's 10 second connect timeout" — the failing requests measured
* on this machine were direct connects.
* @module dsh-proxy/proxy
*/
/** Extract the absolute URL string from a `fetch` input. */
function urlOf(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}
/** One IPv4 octet, so a loopback match cannot accept `127.999.1.1`. */
const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
/**
* The whole `127.0.0.0/8` block, not just its first address: judging only
* `127.0.0.1` misses `127.0.0.2`, which binds to loopback just as surely.
*/
const LOOPBACK_IPV4 = new RegExp("^127\\." + IPV4_OCTET + "\\." + IPV4_OCTET + "\\." + IPV4_OCTET + "$");
/**
* Whether a hostname names this machine, and therefore must stay direct.
*
* **This guarantee is this plugin's own; the routing this was built on had
* none.** The baseline decides purely on `proxyHosts` / `excludeHosts`, which
* is harmless while only a handful of model-API domains are routed, but the
* harness's own Web UI, its Connection transport, and every local test server
* listen on loopback, so a user who writes a loopback endpoint into
* `proxyHosts` would send the harness's own traffic back through the proxy
* and close a loop on it. Loopback is therefore exempt unconditionally.
*
* The test is deliberately **pure string comparison — never DNS**. A lookup
* here would block, could disagree with what the socket actually resolves,
* and would make a routing decision depend on the network being up.
*
* Callers pass `new URL(...).hostname`, which for IPv6 yields the bracketed
* form, so `[::1]` and `[::ffff:127.0.0.1]` are handled alongside the bare
* spellings; a trailing dot (the FQDN spelling `localhost.`) is stripped for
* the same reason `normalizeHostEntry` strips it.
* @param hostname - a URL hostname, bracketed or not, in any case.
* @returns whether the host is loopback or an unspecified address.
*/
function isLoopbackHostname(hostname) {
	const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	if (host === "::1" || host === "::" || host === "0.0.0.0") return true;
	const mappedHigh = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(host)?.[1];
	if (mappedHigh !== void 0) return Number.parseInt(mappedHigh, 16) >>> 8 === 127;
	return LOOPBACK_IPV4.test(host.startsWith("::ffff:") ? host.slice(7) : host);
}
/**
* Whether a hostname must never travel through a proxy at all.
*
* Two builds of the same rule, and both are this plugin's own guarantee rather
* than a configurable one: loopback carries the harness's own surfaces (a
* proxied Web UI request would loop back onto the proxy), and private networks
* carry local model servers, MCP endpoints, and routers (a proxied LAN request
* either fails or leaves the building). Listing such a host in
* `proxyHosts` therefore cannot route it; `excludeHosts` is judged later
* and only ever agrees.
* @param hostname - a URL hostname, bracketed or not, in any case.
* @returns whether the host is exempt from proxying.
*/
function isExemptHostname(hostname) {
	return isLoopbackHostname(hostname) || isLanHostname(hostname);
}
/**
* Whether a URL's hostname is routed through the proxy.
*
* An entry is an umbrella — it covers its own domain and every host built on
* it at any depth (see {@link matchesHostEntry}) — so a single `a.b` reaches
* `a.b`, `*.a.b`, `*.*.a.b`, and the hyphen-joined region siblings. Malformed
* URLs are never proxied.
*
* Exemptions are tested first and always stay direct, whatever the entries say:
* loopback and private networks (see {@link isExemptHostname}). Loopback is
* this plugin's own guarantee rather than a configurable one, so it outranks
* `proxyHosts` and `excludeHosts` alike.
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
		return shouldProxyHostname(new URL(url).hostname, hosts, exclude);
	} catch {
		return false;
	}
}
/**
* The same decision, taken from a hostname the caller already has.
*
* The dispatcher layer reasons about a request's origin and never builds a URL
* for it, so this is the one place the rule lives and {@link shouldProxy} is
* the URL-shaped entry to it.
* @param hostname - the request hostname.
* @param hosts - normalized entries routed through the proxy.
* @param exclude - normalized entries that must never be routed.
* @returns whether the request should travel through the proxy.
*/
function shouldProxyHostname(hostname, hosts, exclude) {
	if (isExemptHostname(hostname)) return false;
	if (exclude !== void 0) {
		for (const entry of exclude) if (matchesHostEntry(hostname, entry)) return false;
	}
	for (const entry of hosts) if (matchesHostEntry(hostname, entry)) return true;
	return false;
}
/** Bind a fetch to one dispatcher, keeping the platform fetch's shape. */
function fetchWith(dispatcher) {
	return ((input, init) => fetch(input, {
		...init,
		dispatcher
	}));
}
/**
* Build one hardened channel.
*
* Without a proxy URL this is the direct channel — the one every unlisted host
* uses, so it carries the same long connect ceiling, TCP keepalive, bounded
* idle window, and transport retry as the proxied one. With a URL it is a
* `ProxyAgent`, and its `connect.timeout` is what bounds the CONNECT tunnel
* (the measured 10.5 s handshake that a 10 s default used to turn into
* UND_ERR_CONNECT_TIMEOUT).
* @param proxyUrl - the proxy endpoint, or undefined/empty for a direct channel.
* @param options - stability settings and the retry reporter.
* @returns the channel, ready to install.
*/
function createHardenedChannel(proxyUrl, options) {
	const agentOptions = agentOptionsOf(options.stability);
	const proxied = typeof proxyUrl === "string" && proxyUrl.length > 0;
	const dispatcher = proxied ? new ProxyAgent({
		uri: proxyUrl,
		...agentOptions
	}) : new Agent(agentOptions);
	const retryPolicy = {
		maxRetries: options.stability.retryCount,
		baseDelayMs: options.stability.retryDelayMs,
		retryOnPossibleDelivery: options.stability.retryOnPossibleDelivery,
		...options.onRetry === void 0 ? {} : { onRetry: options.onRetry }
	};
	return {
		fetch: withTransportRetry(fetchWith(dispatcher), retryPolicy),
		dispatcher,
		proxied,
		close: () => dispatcher.close()
	};
}
/**
* Create a fetch bound to a proxy dispatcher, hardened by the shipped defaults.
*
* Kept as the narrow, single-purpose entry point; the host half builds its
* channels through {@link createHardenedChannel} so it can pass live settings.
* @param proxyUrl - the proxy endpoint.
* @returns the proxy-bound fetch and its dispatcher closer.
*/
function createProxyFetch(proxyUrl) {
	const channel = createHardenedChannel(proxyUrl, { stability: {
		connectTimeoutMs: 6e4,
		responseTimeoutMs: 3e5,
		streamIdleTimeoutMs: 0,
		retryCount: 0,
		retryDelayMs: 400,
		retryOnPossibleDelivery: true
	} });
	return {
		fetch: channel.fetch,
		close: channel.close
	};
}
/**
* Wrap a channel so that requests to `hosts` travel through `proxyFetch` and
* everything else keeps the caller's direct channel.
*
* The direct argument is deliberately the plugin's **hardened direct** fetch
* rather than the platform fetch: a host that is not named in the configuration
* still gets the longer connect ceiling, the keepalive, and the transport retry.
* Falling back to the platform fetch would put every unlisted host back on
* undici's 10 second connect timeout, which is the failure this plugin exists
* to remove.
*
* `exclude` is the highest-priority input: an excluded host keeps the direct
* fetch even when it also matches `hosts`, and an exempt host (loopback or a
* private address) never travels at all (see {@link isExemptHostname}).
* @param proxyFetch - the proxy-bound fetch.
* @param directFetch - this plugin's hardened direct fetch.
* @param hosts - umbrella entries routed through the proxy.
* @param exclude - umbrella entries that must never be routed.
* @returns the routing fetch.
*/
function createRoutingFetch(proxyFetch, directFetch, hosts, exclude) {
	return ((input, init) => {
		return shouldProxy(urlOf(input), hosts, exclude) ? proxyFetch(input, init) : directFetch(input, init);
	});
}
//#endregion
//#region src/dispatch.ts
/**
* The process-wide dispatch layer: one `RoutingDispatcher` that decides, per
* request, which of two channels carries it — the hardened direct channel for
* everything the configuration does not name, the hardened proxy channel for
* the hosts it does name. Exemptions (loopback, private networks, and the
* user's own `excludeHosts`) outrank the routed list, so a name that must not
* travel cannot be made to.
*
* Why install this as the *global* dispatcher and not only wrap
* `globalThis.fetch`: a library may capture `fetch`, call `undici.request`, or hold
* a dispatcher reference from before this plugin mounted. Node's built-in
* `fetch` resolves `getGlobalDispatcher()` per request and undici's global slot is
* a shared `Symbol.for(...)`, so replacing it covers those callers too.
* Verified in the harness's own runtime (Electron 44 / Node 24.18 / undici
* 7.30): a dummy proxy installed here made the built-in fetch fail with
* ECONNREFUSED, and restoring put the original back.
*
* Multi-instance safety mirrors the fetch-wrapper stack in `index.ts`: live
* installs are remembered alongside the dispatcher that preceded them all, a
* retire only re-points the global while it is still one of ours, and the
* machine's own dispatcher comes back when the last install goes. The global
* slot is defined `configurable: false` by undici, so restoration is an
* assignment and never a delete.
* @module dsh-proxy/dispatch
*/
/**
* A dispatcher that routes one request by its origin.
*
* Forwarding is deliberately field-for-field: a dispatcher sits between a
* caller and a socket, so anything rewritten here would be invisible to both.
* A malformed origin takes the direct channel rather than throwing — fail-open,
* so this plugin can never be the reason a request that used to work stopped
* working.
*
* Teardown closes both channels and never destroys them, so an in-flight
* streaming response finishes instead of being cut off by an unload.
*/
var RoutingDispatcher = class extends Dispatcher {
	input;
	constructor(input) {
		super();
		this.input = input;
	}
	/** @inheritdoc */
	dispatch(options, handler) {
		let target = this.input.direct;
		const origin = options?.origin;
		if (origin !== void 0 && origin !== null) try {
			const hostname = hostnameOf(origin);
			if (hostname.length > 0 && !isExemptHostname(hostname) && this.input.proxyFor(hostname)) target = this.input.proxied;
		} catch {
			target = this.input.direct;
		}
		return target.dispatch(options, handler);
	}
	close(callback) {
		const done = Promise.all([this.input.direct.close(), this.input.proxied.close()]).then(() => void 0);
		if (callback === void 0) return done;
		done.then(() => callback(), () => callback());
	}
	destroy(err, callback) {
		const error = typeof err === "function" ? null : err ?? null;
		const done = typeof err === "function" ? err : callback;
		for (const channel of [this.input.direct, this.input.proxied]) try {
			channel.destroy(error);
		} catch {}
		if (done !== void 0) {
			done();
			return;
		}
		return Promise.resolve();
	}
};
/**
* Live global-dispatcher installs, oldest first.
*
* Kept as a stack for the same reason the fetch wrapper is: every instance
* captures the fetch/dispatcher it saw when it mounted, so one instance's
* teardown must hand the global back to another *live* instance — never to its
* own dead predecessor.
*/
const liveDispatchers = [];
/** The dispatcher in place before this module's first install. */
let baseDispatcher;
/** Whether a dispatcher is one this module installed. */
function isLiveDispatcher(candidate) {
	return candidate !== void 0 && liveDispatchers.some((entry) => entry.dispatcher === candidate);
}
/**
* Publish a routing dispatcher as the process-wide one.
* @param token - the installing instance's handle, for uninstallGlobalDispatcher.
* @param dispatcher - the routing dispatcher to install.
*/
function installGlobalDispatcher(token, dispatcher) {
	if (liveDispatchers.length === 0) baseDispatcher = getGlobalDispatcher();
	liveDispatchers.push({
		token,
		dispatcher
	});
	setGlobalDispatcher(dispatcher);
}
/**
* Retire one install, re-pointing the global at the newest live one — or back
* at the dispatcher that preceded them all when none is left.
*
* The global is only touched while it is still one of ours: another plugin may
* have replaced it since, and that replacement is not this module's to undo.
* @param token - the handle installGlobalDispatcher was called with.
* @returns whether the install was still held.
*/
function uninstallGlobalDispatcher(token) {
	const index = liveDispatchers.findIndex((entry) => entry.token === token);
	if (index === -1) return false;
	const removed = liveDispatchers[index];
	liveDispatchers.splice(index, 1);
	const current = getGlobalDispatcher();
	if (removed !== void 0 && current !== removed.dispatcher && !isLiveDispatcher(current)) return true;
	const newest = liveDispatchers[liveDispatchers.length - 1];
	if (newest !== void 0) {
		setGlobalDispatcher(newest.dispatcher);
		return true;
	}
	const base = baseDispatcher;
	baseDispatcher = void 0;
	if (base !== void 0) setGlobalDispatcher(base);
	return true;
}
/** How many installs this module currently holds (tests reach for it). */
function liveDispatcherCount() {
	return liveDispatchers.length;
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
/**
* Loopback entries this plugin always adds to a child's `NO_PROXY`.
*
* Without them, a child that honors the environment would send the harness's
* own loopback traffic (Web UI, Connection transport, local test servers)
* through the proxy and close a loop — the same reason {@link
* isLoopbackHostname} keeps it direct in-process. `::1` and `[::1]` are both
* listed because undici reads a bare `::1` as host `:` on port `1` and would
* never bypass it.
*/
const LOOPBACK_NO_PROXY = [
	"localhost",
	"127.0.0.1",
	"::1",
	"[::1]"
];
/**
* The environment names the subprocess export writes, per policy field.
*
* Both casings are written for every field, exactly as DeepSeek Harness's
* own `@deepseek-ai/dsh-http-proxy` does, because the readers disagree on
* which one they prefer: undici reads the lowercase spelling first, while a
* Windows environment is a single case-insensitive variable, so writing both
* spellings costs nothing there and keeps the export correct on POSIX.
*/
const SUBPROCESS_ENV_NAMES = {
	httpProxy: ["http_proxy", "HTTP_PROXY"],
	httpsProxy: ["https_proxy", "HTTPS_PROXY"],
	noProxy: ["no_proxy", "NO_PROXY"]
};
/**
* The flag that makes a child Node honor the proxy environment.
*
* Written only beside a URL the child can parse. The flag makes Node build a
* proxy dispatcher from the environment at start-up, and a value it cannot
* parse — a bare `notaurl`, or a scheme its env-proxy support rejects — stops
* the child before it runs. `pnpm`, the program this export exists for, is a
* Node program.
*/
const NODE_USE_ENV_PROXY = "NODE_USE_ENV_PROXY";
/**
* The `NO_PROXY` value a child receives: loopback, the machine's own entries,
* and this plugin's exclusions.
*
* Exclusions are the highest-priority input, so they belong in the child's
* bypass list too: a host that must not go through the proxy here must not go
* through it there either. `NO_PROXY` matching is the same umbrella idea one
* level up — a name covers itself and its subdomains — so the entries carry
* over unchanged, and a name the child's matcher cannot express bypasses
* nothing rather than everything.
* @param exclude - normalized exclusion entries.
* @param pristine - the machine's own environment, or `undefined` before the
* first claim captured it (in which case there is nothing of its own to keep).
* @returns the comma-separated bypass list.
*/
function noProxyValue(exclude, pristine) {
	const entries = new Set(LOOPBACK_NO_PROXY);
	for (const name of SUBPROCESS_ENV_NAMES.noProxy) {
		const existing = pristine?.get(name);
		if (existing === void 0) continue;
		for (const entry of existing.split(",")) {
			const trimmed = entry.trim();
			if (trimmed.length > 0) entries.add(trimmed);
		}
	}
	for (const entry of exclude) entries.add(entry);
	return [...entries].join(",");
}
/**
* Live routing wrappers, oldest first. `globalThis.fetch` is the newest of
* them.
*
* Each instance captures the fetch it saw when it mounted, so a teardown that
* restored its own capture would hand the global back to a *previous*
* instance's wrapper — whose dispatcher that instance had already closed,
* leaving every later request to fail with `UND_ERR_DESTROYED`. Keeping the
* live wrappers in one stack means a teardown only ever re-points the global
* at another live wrapper, or at the fetch that was in place before the first
* one.
*/
const liveWrappers = [];
/**
* The fetch that requests which stay direct fall through to: the one in place
* before any of this module's wrappers, so instances never chain through each
* other. Dropped when the last wrapper goes, so a later mount captures
* whatever is current then.
*/
let baseFetch;
/** Whether a fetch is one this module installed. */
function isLiveWrapper(candidate) {
	return liveWrappers.some((entry) => entry.wrapper === candidate);
}
/**
* Publish a wrapper as the newest one, remembering the fetch it replaced if it
* is the first.
* @param token - the installing instance's handle, for {@link uninstallWrapper}.
* @param wrapper - the routing fetch to install.
*/
function installWrapper(token, wrapper) {
	liveWrappers.push({
		token,
		wrapper
	});
	globalThis.fetch = wrapper;
}
/**
* Retire a wrapper, re-pointing the global at the newest one still live — or
* back at the fetch that preceded them all when none is.
*
* The global is only touched while it is still one of ours: another plugin may
* have replaced it since, and that replacement is not this module's to undo.
* @param token - the handle {@link installWrapper} returned.
*/
function uninstallWrapper(token) {
	const index = liveWrappers.findIndex((entry) => entry.token === token);
	if (index === -1) return;
	const removed = liveWrappers[index];
	liveWrappers.splice(index, 1);
	if (removed !== void 0 && globalThis.fetch !== removed.wrapper && !isLiveWrapper(globalThis.fetch)) return;
	const newest = liveWrappers[liveWrappers.length - 1];
	if (newest !== void 0) {
		globalThis.fetch = newest.wrapper;
		return;
	}
	const base = baseFetch;
	baseFetch = void 0;
	if (base !== void 0) globalThis.fetch = base;
}
/**
* Live claims on the subprocess export, newest last.
*
* `process.env` is process-wide while a plugin instance is not: the loader
* mounts and disposes entries concurrently, so two instances can be alive at
* once and either may unload first. A snapshot private to one instance would
* then let the one unloading delete what the other had written, and leave the
* survivor's address behind for good. So every instance registers a claim
* here and the environment is derived from the newest one; withdrawing a claim
* re-derives it from whatever is left, and the machine's own values come back
* only when the last claim goes.
*/
const exportClaims = /* @__PURE__ */ new Map();
/**
* The machine's own environment, captured once before the first claim wrote,
* and dropped when the last claim is withdrawn.
*
* It is the merge base for `NO_PROXY`, not the live environment: reading the
* live one would make a later claim inherit the previous claim's entries,
* which then could never be removed.
*/
let pristineEnv;
/** Every name the export writes, both casings included. */
const EXPORT_ENV_NAMES = [
	...SUBPROCESS_ENV_NAMES.httpProxy,
	...SUBPROCESS_ENV_NAMES.httpsProxy,
	...SUBPROCESS_ENV_NAMES.noProxy,
	NODE_USE_ENV_PROXY
];
/**
* Write the environment for the newest claim, or put the machine's own back
* when there is none left.
*/
function applyExport() {
	let newest;
	for (const claim of exportClaims.values()) newest = claim;
	if (newest === void 0) {
		const pristine = pristineEnv;
		if (pristine === void 0) return;
		pristineEnv = void 0;
		for (const [name, value] of pristine) if (value === void 0) Reflect.deleteProperty(process.env, name);
		else process.env[name] = value;
		return;
	}
	const noProxy = noProxyValue(newest.exclude, pristineEnv);
	for (const name of SUBPROCESS_ENV_NAMES.httpProxy) process.env[name] = newest.proxyUrl;
	for (const name of SUBPROCESS_ENV_NAMES.httpsProxy) process.env[name] = newest.proxyUrl;
	for (const name of SUBPROCESS_ENV_NAMES.noProxy) process.env[name] = noProxy;
	process.env[NODE_USE_ENV_PROXY] = "1";
}
/**
* Export the resolved proxy to child processes through `process.env`.
*
* This is the only channel that reaches `pnpm` and `git`: they read the
* environment, not this plugin's wrapped `fetch`, so plugin installation and
* update stay direct without it. The values are written to `process.env`
* itself, which is what DSH's own spawn paths copy into a child (see
* `scrubbedParentEnv` in `@deepseek-ai/dsh-subprocess`) — including the
* `pnpm` spawn of the plugin manager, so an install inherits this routing.
*
* A URL a child cannot parse is never written, because the flag beside it
* would then stop that child at start-up and break plugin installation
* outright. Callers check {@link isValidSubprocessProxy} first, and an invalid
* URL leaves the environment untouched.
* @param proxyUrl - the resolved proxy URL (already known to be valid).
* @param exclude - normalized exclusion entries for the child's `NO_PROXY`.
* @returns a token identifying this claim, for {@link releaseSubprocessExport}.
*/
function claimSubprocessExport(proxyUrl, exclude) {
	if (pristineEnv === void 0) {
		const pristine = /* @__PURE__ */ new Map();
		for (const name of EXPORT_ENV_NAMES) pristine.set(name, process.env[name]);
		pristineEnv = pristine;
	}
	const token = Symbol("dsh-proxy subprocess export");
	exportClaims.set(token, {
		proxyUrl,
		exclude
	});
	applyExport();
	return token;
}
/**
* Withdraw one claim on the subprocess export.
*
* The environment is re-derived from the remaining claims, and only the last
* withdrawal puts the machine's own values back — so one instance unloading
* can never revoke an export another instance still holds. A name that did not
* exist is deleted rather than blanked: an empty `HTTP_PROXY` is not the same
* as an absent one, and a child that reads the empty string sees a proxy it
* cannot parse.
* @param token - the claim to withdraw.
* @returns whether the claim was still held.
*/
function releaseSubprocessExport(token) {
	if (!exportClaims.delete(token)) return false;
	applyExport();
	return true;
}
/**
* Collect the hostnames that should travel through the proxy.
*
* The configured `proxyHosts` is the whole routed set — there is no
* auto-detected list behind it, so an empty list routes nothing and the
* settings page can promise exactly that. `excludeHosts` comes back beside
* it as a separate set because it is judged first and cannot be expressed as
* a subtraction from the routed set (see {@link ProxyTargets}).
*
* Every entry is an umbrella: `a.b` covers `a.b` and the whole subtree under
* it (see `matchesHostEntry`), so a domain is named once rather than per
* endpoint.
* @param ctx - the Cordis context, for the optional settings service.
* @param config - the current plugin configuration.
* @returns the routed and excluded entry sets.
*/
function collectProxyHosts(config) {
	const hosts = /* @__PURE__ */ new Set();
	for (const host of config.proxyHosts) {
		const normalized = normalizeHostEntry(host);
		if (normalized !== void 0) hosts.add(normalized);
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
* Whether two stability snapshots would build the same channels.
*
* A connection pool carries the timeouts it was built with, so a change to any
* of them has to rebuild. Together with the proxy address and the host lists
* this decides whether a volatile update touches the request path at all: an
* unrelated edit must not re-dial every idle connection.
* @param left - the settings the live generation was built from.
* @param right - the settings the current configuration resolves to.
* @returns whether the live channels may be kept.
*/
function sameStability(left, right) {
	return left.connectTimeoutMs === right.connectTimeoutMs && left.responseTimeoutMs === right.responseTimeoutMs && left.streamIdleTimeoutMs === right.streamIdleTimeoutMs && left.retryCount === right.retryCount && left.retryDelayMs === right.retryDelayMs && left.retryOnPossibleDelivery === right.retryOnPossibleDelivery;
}
/**
* Build this instance's transport-retry reporter.
*
* A retry is worth a warning — it means a connection was dropped and re-dialled
* — but a gateway that is shedding connections would otherwise fill the log, so
* the report is throttled per transport code: one repeated code is noise, a new
* code is news.
* @param ctx - the Cordis context, for the logger.
* @returns the reporter handed to both channels.
*/
function makeRetryReporter(ctx) {
	const lastSeen = /* @__PURE__ */ new Map();
	const windowMs = 6e4;
	return (attempt) => {
		const now = Date.now();
		if (now - (lastSeen.get(attempt.code) ?? 0) < windowMs) return;
		lastSeen.set(attempt.code, now);
		ctx.logger.warn("dsh-proxy: transport retry %d/%d after %s (%s)", attempt.attempt, attempt.maxRetries, attempt.code, attempt.url);
	};
}
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
function apply(ctx, config) {
	/**
	* The active generation: the settings it was built from and the routing
	* dispatcher holding both channels.
	*
	* `stability` is part of the identity on purpose. A connection pool carries
	* the timeouts it was built with, so a timeout edit must rebuild; an
	* unrelated volatile update must not, because a rebuild re-dials every idle
	* connection.
	*/
	let active;
	/** This instance's live global-dispatcher install, when it holds one. */
	let dispatcherInstalled;
	let disposed = false;
	/**
	* This instance's live wrapper, when it has one installed. Held as the stack
	* handle so teardown retires exactly its own entry (see
	* {@link uninstallWrapper}).
	*/
	let installed;
	/**
	* This instance's claim on the process-wide subprocess export, when it holds
	* one. The environment itself is derived at module scope from every live
	* claim (see {@link exportClaims}); the token is what lets this instance
	* withdraw its own claim on unload without touching another instance's.
	*/
	let subprocess;
	/**
	* Whether the last refresh saw a configuration that carries nothing: no
	* proxy URL (settings, the system, or `DSH_HTTP_PROXY`), no host entries, and
	* no system-proxy switch.
	*/
	let vacant = true;
	const deactivate = () => {
		if (installed !== void 0) {
			uninstallWrapper(installed);
			installed = void 0;
		}
		if (dispatcherInstalled !== void 0) {
			uninstallGlobalDispatcher(dispatcherInstalled);
			dispatcherInstalled = void 0;
		}
		if (active === void 0) return;
		const entry = active;
		active = void 0;
		entry.routing.close().catch(() => {});
	};
	/**
	* Drop this instance's subprocess export, if it still holds one.
	*
	* Called before every new export and on unload, so the environment never
	* carries two generations of values, and so a plugin that is switched off
	* stops steering `pnpm` and `git`. Withdrawing by token keeps this safe when
	* another instance has since taken the export over: in that case this call
	* does nothing, because the live export is no longer ours to remove.
	*/
	const dropSubprocess = () => {
		if (subprocess === void 0) return;
		releaseSubprocessExport(subprocess);
		subprocess = void 0;
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
		const cfg = readConfig(config, (message) => ctx.logger.warn(message));
		const stability = cfg.stability;
		const system = cfg.useSystemProxy ? readSystemProxy() : void 0;
		const detected = system?.proxy ?? "";
		const proxyUrl = detected.length > 0 ? detected : cfg.proxy.length > 0 ? cfg.proxy : process.env.DSH_HTTP_PROXY ?? "";
		if (system !== void 0) reportSystemProxy(system, proxyUrl);
		vacant = proxyUrl.length === 0 && cfg.proxyHosts.length === 0 && cfg.excludeHosts.length === 0 && !cfg.useSystemProxy && !cfg.proxySubprocesses && stabilityIsDefault(stability);
		if (proxyUrl.length === 0) {
			deactivate();
			dropSubprocess();
			if (vacant) cleanProfileIfOff("cleared settings");
			return;
		}
		const targets = collectProxyHosts(cfg);
		dropSubprocess();
		if (cfg.proxySubprocesses) {
			if (isValidSubprocessProxy(proxyUrl)) subprocess = claimSubprocessExport(proxyUrl, targets.exclude);
			else ctx.logger.warn("dsh-proxy: cannot export the proxy \"%s\" to child processes (only http/https works); plugin installs stay direct", proxyUrl);
		}
		if (active !== void 0 && active.proxyUrl === proxyUrl && sameTargets(active.targets, targets) && sameStability(active.stability, stability)) return;
		let direct;
		let proxied;
		let routing;
		try {
			assertValid({ proxy: proxyUrl });
			const onRetry = makeRetryReporter(ctx);
			direct = createHardenedChannel(void 0, {
				stability,
				onRetry
			});
			proxied = createHardenedChannel(proxyUrl, {
				stability,
				onRetry
			});
			routing = new RoutingDispatcher({
				direct: direct.dispatcher,
				proxied: proxied.dispatcher,
				proxyFor: (hostname) => shouldProxyHostname(hostname, targets.hosts, targets.exclude)
			});
		} catch (cause) {
			ctx.logger.warn("dsh-proxy: invalid proxy URL \"%s\" (%s); routing stays off", proxyUrl, cause instanceof Error ? cause.message : String(cause));
			deactivate();
			dropSubprocess();
			return;
		}
		const next = {
			proxyUrl,
			targets,
			stability,
			routing
		};
		const previous = active;
		active = next;
		if (installed !== void 0) {
			uninstallWrapper(installed);
			installed = void 0;
		}
		if (baseFetch === void 0 && liveWrappers.length === 0) baseFetch = globalThis.fetch;
		const dispatcherToken = Symbol("dsh-proxy dispatcher");
		installGlobalDispatcher(dispatcherToken, routing);
		dispatcherInstalled = dispatcherToken;
		const wrapper = createRoutingFetch(proxied.fetch, direct.fetch, targets.hosts, targets.exclude);
		const token = Symbol("dsh-proxy wrapper");
		installWrapper(token, wrapper);
		installed = token;
		ctx.logger.info("dsh-proxy: routing installed — proxied hosts %d, exclusions %d, %s", targets.hosts.size, targets.exclude.size, describeStability(stability));
		if (previous !== void 0) previous.routing.close().catch(() => {});
	};
	refresh();
	installSystemProxyRpc(ctx);
	ctx.effect(() => () => {
		disposed = true;
		deactivate();
		dropSubprocess();
		cleanProfileIfOff("plugin unloaded");
	});
	ctx.on("loader/volatile-update", () => {
		refresh();
	});
}
//#endregion
export { Config, DEFAULT_STABILITY, POOLED_IDLE_WINDOW_MS, PROFILE_MANIFEST_FILE, PROFILE_PATCH_FILE, PROXY_ENTRY_ID, PROXY_ENV_NAMES, PROXY_IDENTITIES, PROXY_PACKAGE_NAME, RoutingDispatcher, STABILITY_BOUNDS, STABILITY_FIELDS, SUBPROCESS_PROXY_SCHEMES, SUPPORTED_PROXY_SCHEMES, SYSTEM_PROXY_CHANNEL, SYSTEM_PROXY_ENDPOINT, SYSTEM_PROXY_ROUTE, TCP_KEEPALIVE_DELAY_MS, WINDOWS_INTERNET_SETTINGS_KEY, agentOptionsOf, apply, assertValid, createHardenedChannel, createProxyFetch, createRoutingFetch, describeStability, hostnameOf, installGlobalDispatcher, installSystemProxyRpc, isAborted, isExemptHostname, isLanHostname, isLoopbackHostname, isReplayableRequest, isRetryableTransportError, isValidSubprocessProxy, liveDispatcherCount, matchesHostEntry, name, normalizeHostEntry, normalizeProxyValue, parseGsettingsValue, parseScutilProxy, parseWindowsProxyServer, parseWindowsRegistry, pickWindowsProxy, planRowCleanup, profileDir, profileManifestPath, profilePatchPath, pruneProxyEntry, pruneProxyEntryFromProfile, readBundleSelection, readConfig, readEnvironmentProxy, readMacSystemProxy, readProxyEntryState, readStability, readSystemProxy, readWindowsSystemProxy, shouldProxy, shouldProxyHostname, stabilityIsDefault, stripProxyEntryConfig, stripProxyEntryConfigFromProfile, transportCodeOf, uninstallGlobalDispatcher, urlOf, withTransportRetry };
