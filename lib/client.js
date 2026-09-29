window.__ModuleLoader__.load({
	id: "dsh-proxy",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
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
		/**
		* Split a host field's text into entries. Commas and any whitespace separate,
		* so the browser page's one-line controls and the stored `string[]` section
		* agree on what the user typed.
		* @param text - the control's draft text.
		* @returns the non-empty entries, in order.
		*/
		function splitHostEntries(text) {
			return text.split(/[,\s]+/).filter((part) => part.length > 0);
		}
		//#endregion
		//#region \0dsh-css:A:\Downloads\dsh-proxy\src\client\section.module.css.mjs
		const css = ".O6ZfEa_section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}.O6ZfEa_heading{margin:0;font-size:18px;font-weight:600}.O6ZfEa_intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px}.O6ZfEa_systemProxy{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;flex-direction:column;gap:6px;padding:10px 12px;display:flex}.O6ZfEa_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}.O6ZfEa_status{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:1.5}";
		const tagId = "dsh-proxy/section.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-proxy";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var section_module_css_default = {
			"heading": "O6ZfEa_heading",
			"hint": "O6ZfEa_hint",
			"intro": "O6ZfEa_intro",
			"section": "O6ZfEa_section",
			"status": "O6ZfEa_status",
			"systemProxy": "O6ZfEa_systemProxy"
		};
		//#endregion
		//#region src/client/section.tsx
		/**
		* The dsh-proxy settings page: the page the Settings panel's own left-hand
		* navigation opens, rendered in the content column beside the bundled ones.
		*
		* A plugin that owns a settings page draws the column contents — the shell
		* contributes the nav row — so this file owns the heading, the one-line intro,
		* and the three controls. The controls are the host's own `SettingsForm` +
		* `SettingsValueField`, which is what gives the page the overridden badge, the
		* reset-to-default control, the staged-draft save, and the read-only and
		* unavailable notices without this plugin restating any of them.
		* @module dsh-proxy/client/section
		*/
		/** The form frame's copy, read from this page's dictionary. */
		function formLabels(t) {
			return {
				unavailable: t("unavailable"),
				readOnly: t("readOnly"),
				saveFailed: t("saveFailed"),
				save: t("save"),
				saving: t("saving")
			};
		}
		/**
		* Append one host to a control's text, skipping one an entry already covers.
		*
		* Entries are umbrellas, so listing `commandcode.ai` already reaches
		* `api.commandcode.ai` — offering to add the child would only add a redundant
		* line the Host half would treat identically.
		*/
		function appendHost(current, host) {
			const parts = splitHostEntries(current);
			if (!parts.some((part) => {
				const entry = normalizeHostEntry(part);
				return entry !== void 0 && matchesHostEntry(host, entry);
			})) parts.push(host);
			return parts.join(", ");
		}
		/**
		* The known-host pick list, disclosed by the information button beside a host
		* field's label.
		*
		* It is a convenience, not the field's vocabulary: the control stays free
		* text, so a private gateway nothing here knows about is typed as usual. A
		* host the field already covers is left out rather than offered and then
		* deduplicated on the way in.
		*/
		function KnownHosts(props) {
			const entries = splitHostEntries(props.current).map((entry) => normalizeHostEntry(entry)).filter((entry) => entry !== void 0);
			const options = props.hosts.filter((host) => !entries.some((entry) => matchesHostEntry(host, entry)));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: options.length > 0 ? props.t("suggestionsHint") : props.t("suggestionsEmpty") }), options.map((host) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				variant: "ghost",
				size: "sm",
				disabled: props.disabled,
				onClick: () => {
					props.onPick(host);
				},
				children: host
			}, host))] });
		}
		/** One host field: the shared value field plus its pick list. */
		function HostField(props) {
			const { t } = props;
			const help = {
				label: t("suggestions"),
				content: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(KnownHosts, {
					t,
					hosts: props.suggestions,
					current: props.state.text,
					disabled: props.disabled,
					onPick: props.onPick
				})
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SettingsValueField, {
				id: props.id,
				label: props.label,
				hint: props.hint,
				overriddenLabel: t("overridden"),
				resetLabel: t("reset"),
				invalidLabel: t("invalid"),
				help,
				disabled: props.disabled,
				...props.state,
				onEdit: props.onEdit,
				onReset: props.onReset
			});
		}
		/**
		* Name the mechanism a reading came from, in the active locale.
		* @param t - this page's translate function.
		* @param source - the reading's source.
		* @returns one short phrase to append to the status line.
		*/
		function sourceLabel(t, source) {
			switch (source) {
				case "windows-registry": return t("systemProxyFromWindows");
				case "env": return t("systemProxyFromEnv");
				case "macos-scutil": return t("systemProxyFromMacos");
				case "linux-gsettings": return t("systemProxyFromLinux");
				default: return t("systemProxyFromNone");
			}
		}
		/**
		* The "use the system proxy" switch and the line reporting what reading it
		* produced.
		*
		* The switch is a staged field like every other control on the page, but the
		* reading it triggers is immediate: the Host is asked as soon as the box is
		* ticked, and the answer drafts the address field above it, ready for the same
		* save. The status line is page-local state — it describes one attempt, not a
		* setting.
		*/
		function SystemProxyControl(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: section_module_css_default.systemProxy,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Checkbox, {
						checked: props.state.text === "true",
						disabled: props.disabled,
						label: props.t("useSystemProxy"),
						onChange: props.onToggle
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: section_module_css_default.hint,
						children: props.t("useSystemProxyHint")
					}),
					props.status !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: section_module_css_default.status,
						role: "status",
						children: props.status
					}) : null
				]
			});
		}
		/**
		* Render the dsh-proxy settings page.
		* @param props - locale copy, the page snapshot, and its form actions.
		* @returns the page column.
		*/
		function HttpProxySection(props) {
			const { t } = props;
			const state = props.useHttpProxyForm((snapshot) => snapshot);
			const disabled = !state.writable;
			/** What the last attempt to read the system proxy reported. */
			const [status, setStatus] = (0, react.useState)(void 0);
			/**
			* Stage the switch, and — when it is being turned on — read the machine's
			* proxy and draft the address field with it.
			*
			* Unticking only stages the switch: an address already on screen is the
			* user's to keep or clear, never something this control deletes.
			* @param checked - the box's requested state.
			*/
			const toggleSystemProxy = async (checked) => {
				props.edit("useSystemProxy", checked ? "true" : "false");
				if (!checked) {
					setStatus(void 0);
					return;
				}
				setStatus(t("systemProxyReading"));
				const outcome = await props.readSystemProxy();
				if (outcome.status === "unavailable") {
					setStatus(t("systemProxyUnavailable"));
					return;
				}
				if (outcome.status === "failed") {
					setStatus(`${t("systemProxyFailed")}: ${outcome.message}`);
					return;
				}
				const { reading } = outcome;
				if (reading.proxy.length === 0) {
					setStatus(reading.pacUrl === void 0 ? t("systemProxyNone") : `${t("systemProxyPac")}: ${reading.pacUrl}`);
					return;
				}
				props.edit("proxy", reading.proxy);
				setStatus(`${t("systemProxyDetected")}: ${reading.proxy} · ${sourceLabel(t, reading.source)}`);
			};
			const hostField = (field, id, label, hint) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(HostField, {
				t,
				id,
				label,
				hint,
				state: state[field],
				suggestions: state.suggestions,
				disabled,
				onEdit: (text) => {
					props.edit(field, text);
				},
				onReset: () => {
					props.resetField(field);
				},
				onPick: (host) => {
					props.edit(field, appendHost(state[field].text, host));
				}
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: section_module_css_default.section,
				"aria-labelledby": "dsh-proxy-heading",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: section_module_css_default.heading,
						id: "dsh-proxy-heading",
						children: t("title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: section_module_css_default.intro,
						children: t("description")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.SettingsForm, {
						labels: formLabels(t),
						state,
						onSave: props.save,
						onDiscard: props.discard,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SettingsValueField, {
								id: "dsh-proxy-url",
								label: t("proxy"),
								hint: t("proxyHint"),
								placeholder: "socks5://127.0.0.1:7890",
								overriddenLabel: t("overridden"),
								resetLabel: t("reset"),
								invalidLabel: t("invalid"),
								disabled,
								...state.proxy,
								onEdit: (text) => {
									props.edit("proxy", text);
								},
								onReset: () => {
									props.resetField("proxy");
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SystemProxyControl, {
								t,
								state: state.useSystemProxy,
								disabled,
								status,
								onToggle: (checked) => {
									toggleSystemProxy(checked);
								}
							}),
							hostField("proxyHosts", "dsh-proxy-hosts", t("hosts"), t("hostsHint")),
							hostField("excludeHosts", "dsh-proxy-exclude", t("exclude"), t("excludeHint"))
						]
					})
				]
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
		//#endregion
		//#region src/client/connection.ts
		/**
		* Read the browser `connection` service's RPC caller.
		*
		* Called per request rather than cached: Connection may be provided after this
		* plugin loads, and a deployment that never provides it leaves the caller
		* undefined.
		* @param ctx - the browser plugin context.
		* @returns the caller, or undefined when this deployment has no Connection.
		*/
		function clientRpc(ctx) {
			const read = ctx.get;
			if (typeof read !== "function") return void 0;
			return read.call(ctx, "connection")?.rpc;
		}
		//#endregion
		//#region src/client/form-controller.ts
		/**
		* A host-list field: one line of text over a `string[]`.
		*
		* The stored section holds an array, the control holds comma-separated text,
		* and an empty draft clears the field — the same gesture as resetting it, so
		* emptying the box means "auto-detect" rather than "proxy nothing".
		* @param field - field name inside the namespace section.
		* @returns the field's conversion spec.
		*/
		function settingsHostListField(field) {
			return {
				field,
				format: (value) => Array.isArray(value) ? value.filter((host) => typeof host === "string").join(", ") : "",
				parse: (text) => {
					const hosts = splitHostEntries(text);
					return hosts.length === 0 ? { kind: "clear" } : {
						kind: "set",
						value: hosts
					};
				}
			};
		}
		/**
		* A boolean field: the checkbox holds `"true"`/`"false"` text, and a save
		* writes the boolean the Host schema declares.
		*
		* A checkbox has no third state, so unlike the text fields this one never
		* clears: unticking stores an explicit `false`, which is what the Host reads
		* anyway (an absent value defaults to `false`).
		* @param field - field name inside the namespace section.
		* @returns the field's conversion spec.
		*/
		function settingsBooleanField(field) {
			return {
				field,
				format: (value) => value === true ? "true" : "false",
				parse: (text) => ({
					kind: "set",
					value: text.trim().toLowerCase() === "true"
				})
			};
		}
		/** The sources a reading may name, so a wire value outside the union reads as `none`. */
		const SYSTEM_PROXY_SOURCES = [
			"windows-registry",
			"env",
			"macos-scutil",
			"linux-gsettings",
			"none"
		];
		/**
		* Coerce one wire value into a reading.
		*
		* The Host owns the shape, so this only defends the page against a Host that is
		* older, newer, or broken: anything missing reads as an empty field rather than
		* crashing the render.
		* @param value - the endpoint's success value.
		* @returns the reading, or undefined when there is no object to read.
		*/
		function asReading(value) {
			if (typeof value !== "object" || value === null) return void 0;
			const record = value;
			const source = SYSTEM_PROXY_SOURCES.find((candidate) => candidate === record.source) ?? "none";
			const pacUrl = typeof record.pacUrl === "string" && record.pacUrl.length > 0 ? record.pacUrl : void 0;
			return {
				proxy: typeof record.proxy === "string" ? record.proxy : "",
				source,
				detail: typeof record.detail === "string" ? record.detail : "",
				platform: typeof record.platform === "string" ? record.platform : "",
				...pacUrl === void 0 ? {} : { pacUrl }
			};
		}
		/** Bridges the `dsh-proxy` config form onto the settings page. */
		var HttpProxyFormController = class {
			ctx;
			scope;
			knownNs;
			form;
			mirror;
			store;
			disposers = [];
			/**
			* @param ctx - the browser plugin context, for the shared settings mirror.
			* @param scope - the shared config form of the `dsh-proxy` Host entry.
			* @param knownNs - namespace whose configured gateways feed the pick list.
			*/
			constructor(ctx, scope, knownNs) {
				this.ctx = ctx;
				this.scope = scope;
				this.knownNs = knownNs;
				this.form = new _deepseek_ai_dsh_client_ui_primitives.SettingsFormModel(scope, [
					(0, _deepseek_ai_dsh_client_ui_primitives.settingsTextField)("proxy"),
					settingsHostListField("proxyHosts"),
					settingsHostListField("excludeHosts"),
					settingsBooleanField("useSystemProxy")
				]);
				this.mirror = ctx.configForms.describe();
				this.store = this.form.bind(() => this.projection());
				this.disposers.push(this.mirror.subscribe(() => {
					this.publish();
				}));
				this.mirror.ensure();
			}
			/** Stop observing the mirror and the form. Idempotent. */
			dispose() {
				for (const disposer of this.disposers.splice(0)) disposer();
				this.form.dispose();
			}
			/**
			* Build the face the section's slot registration injects.
			* @returns the page's snapshot and its form actions.
			*/
			inject() {
				return {
					hooks: { httpProxyForm: this.store },
					readSystemProxy: () => this.readSystemProxy(),
					...this.form.actions()
				};
			}
			/**
			* Ask the Host half what proxy this machine is configured with.
			*
			* The browser cannot read a registry, so the checkbox is a round trip: the
			* answer either carries a reading the page fills its field from, or says why
			* there is none. Nothing here throws — the page shows the failure and leaves
			* the form alone.
			* @returns the reading, or why there is none.
			*/
			async readSystemProxy() {
				const rpc = clientRpc(this.ctx);
				if (rpc === void 0) return { status: "unavailable" };
				let value;
				try {
					const result = await rpc.call(SYSTEM_PROXY_CHANNEL, SYSTEM_PROXY_ENDPOINT, {});
					if (!result.ok) return {
						status: "failed",
						message: result.error.message
					};
					value = result.value;
				} catch (cause) {
					return {
						status: "failed",
						message: cause instanceof Error ? cause.message : String(cause)
					};
				}
				const reading = asReading(value);
				return reading === void 0 ? {
					status: "failed",
					message: "the Host returned no reading"
				} : {
					status: "ok",
					reading
				};
			}
			publish() {
				this.store.set(this.projection());
			}
			projection() {
				return {
					...this.form.shell(),
					proxy: this.form.field("proxy"),
					proxyHosts: this.form.field("proxyHosts"),
					excludeHosts: this.form.field("excludeHosts"),
					useSystemProxy: this.form.field("useSystemProxy"),
					suggestions: this.suggestions()
				};
			}
			/**
			* Hostnames offered by the host fields: the default DeepSeek host, the
			* built-in pi-ai catalog endpoints, every configured gateway, and what is
			* already saved.
			*/
			suggestions() {
				const hosts = /* @__PURE__ */ new Set([
					DEFAULT_DEEPSEEK_HOST,
					...DEFAULT_MODEL_HOSTS,
					...DEFAULT_MODEL_HOST_SUFFIXES
				]);
				const saved = this.scope.getSnapshot().value ?? {};
				for (const list of [saved.proxyHosts, saved.excludeHosts]) {
					if (!Array.isArray(list)) continue;
					for (const host of list) {
						if (typeof host !== "string") continue;
						const normalized = normalizeHostEntry(host);
						if (normalized !== void 0) hosts.add(normalized);
					}
				}
				const known = (this.mirror.getSnapshot().view?.namespaces.find((ns) => ns.ns === this.knownNs))?.value;
				for (const profile of Object.values(known?.providers ?? {})) {
					const baseURL = profile.baseURL;
					if (typeof baseURL === "string" && baseURL.length > 0) try {
						hosts.add(hostnameOf(baseURL));
					} catch {}
				}
				return [...hosts].sort();
			}
		};
		//#endregion
		//#region src/client/contract.ts
		/**
		* Settings namespace of this plugin — the Host-side profile entry id that
		* carries its config, and therefore the id the form is opened by. Kept in
		* sync with the `id` in `cordis.patch.yml`.
		*/
		const SETTINGS_NS = "dsh-proxy";
		/**
		* Key of this plugin's row in the Settings panel's left-hand navigation. The
		* section key drives `only` filtering, so it must be unique among sections;
		* `navIcon` in the shell gives an unrecognized key its default gear.
		*/
		const SECTION_ID = "dsh-proxy";
		/**
		* Navigation position. The bundled sections are `account` (-10), `general`
		* (0), `models` (10) and `plugins` (15); a network/transport preference reads
		* best after those rather than between two of them.
		*/
		const SECTION_ORDER = 20;
		/** The `llm-pi-ai` namespace, read-only here, supplying gateway hostname suggestions. */
		const PI_AI_NS = "llm-pi-ai";
		/** Dictionary namespace owned by this plugin. */
		const LOCALE_NS = "settings.httpProxy";
		//#endregion
		//#region src/client/locales.ts
		/**
		* Locale bundles for the dsh-proxy settings card.
		*
		* Both shipped languages are required together by `ctx.locale.register`, and
		* the key sets are checked against the namespace declaration in
		* `contract.ts` — so a key added to one dictionary and forgotten in the other
		* is a compile error rather than a raw key on screen.
		* @module dsh-proxy/client/locales
		*/
		/** English copy. */
		const en = {
			title: "HTTP proxy",
			description: "Send model-API requests through a forward proxy; everything else stays direct.",
			proxy: "Proxy URL",
			proxyHint: "http / https / socks4 / socks4a / socks5 / socks5h. Leave blank to switch the plugin off.",
			useSystemProxy: "Use the system proxy",
			useSystemProxyHint: "Ticking this reads the machine's proxy settings right away and fills the address above with what it finds. While it is ticked, the plugin prefers the system proxy.",
			systemProxyReading: "Reading the system proxy…",
			systemProxyDetected: "Found system proxy",
			systemProxyNone: "This machine configures no proxy, so the address above was left as it is.",
			systemProxyPac: "This machine configures its proxy through an auto-config script (PAC), which this plugin cannot resolve",
			systemProxyUnavailable: "This deployment has no Host connection, so the system proxy cannot be read.",
			systemProxyFailed: "Could not read the system proxy",
			systemProxyFromWindows: "Windows Internet Settings",
			systemProxyFromEnv: "a proxy environment variable",
			systemProxyFromMacos: "macOS network settings",
			systemProxyFromLinux: "GNOME network settings",
			systemProxyFromNone: "an unknown source",
			hosts: "Proxy only these hosts",
			hostsHint: "Blank means every model host is detected automatically. Otherwise only these are proxied — comma-separated, accepting host, host:port, URL, or a .domain suffix.",
			exclude: "Excluded hosts",
			excludeHint: "Never proxied, whatever else is configured — same entry forms as above.",
			suggestions: "Known model hosts",
			suggestionsHint: "Pick a known host to add it to this field.",
			suggestionsEmpty: "Every known host is already listed.",
			overridden: "Overridden",
			reset: "Reset to default",
			invalid: "This value is not accepted.",
			readOnly: "This deployment stores settings read-only.",
			unavailable: "This plugin is not loaded, so it cannot be configured right now.",
			save: "Save",
			saving: "Saving…",
			saveFailed: "The deployment did not accept these values; they were left for you to correct."
		};
		/** Simplified Chinese copy. */
		const zh = {
			title: "HTTP 代理",
			description: "给模型 API 请求配置正向代理；web 搜索等其它请求仍直连。",
			proxy: "代理地址",
			proxyHint: "支持 http / https / socks4 / socks4a / socks5 / socks5h；留空则插件不生效。",
			useSystemProxy: "使用系统代理",
			useSystemProxyHint: "勾选后立即读取本机的系统代理设置，并把读到的地址填入上面的字段；勾选期间插件优先使用系统代理。",
			systemProxyReading: "正在读取系统代理…",
			systemProxyDetected: "已读取系统代理",
			systemProxyNone: "本机没有配置代理，上面的地址保持原样。",
			systemProxyPac: "本机通过自动配置脚本(PAC)设置代理，本插件无法解析",
			systemProxyUnavailable: "当前部署没有宿主连接通道，无法读取系统代理。",
			systemProxyFailed: "读取系统代理失败",
			systemProxyFromWindows: "Windows Internet 设置",
			systemProxyFromEnv: "代理环境变量",
			systemProxyFromMacos: "macOS 网络设置",
			systemProxyFromLinux: "GNOME 网络设置",
			systemProxyFromNone: "来源未知",
			hosts: "只代理这些域名",
			hostsHint: "留空 = 自动代理所有模型域名；填写 = 只代理列出的这些域名（逗号分隔，支持域名 / 域名:端口 / URL / .域名后缀）。",
			exclude: "排除域名",
			excludeHint: "永远不走代理，优先级最高（写法同上）。",
			suggestions: "已知模型域名",
			suggestionsHint: "点选一个已知域名，把它加入本字段。",
			suggestionsEmpty: "已知域名都已列出。",
			overridden: "已覆盖",
			reset: "恢复默认",
			invalid: "该值不被接受。",
			readOnly: "本部署的设置为只读。",
			unavailable: "该插件当前未加载，暂时无法配置。",
			save: "保存",
			saving: "保存中…",
			saveFailed: "本部署没有接受这些值，已保留供你修改。"
		};
		//#endregion
		//#region src/client/index.ts
		/** Required services (cordis fiber inject). */
		const inject = [
			"slots",
			"locale",
			"configForms"
		];
		/**
		* Mount the dsh-proxy settings page.
		* @param ctx - the browser plugin context.
		*/
		function apply(ctx) {
			const t = ctx.locale.bind(LOCALE_NS);
			ctx.effect(() => ctx.locale.register(LOCALE_NS, {
				zh,
				en
			}), "dsh-proxy: dictionaries");
			const controller = new HttpProxyFormController(ctx, ctx.configForms.get(SETTINGS_NS), PI_AI_NS);
			ctx.effect(() => () => controller.dispose(), "dsh-proxy: form subscription");
			ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: SECTION_ID,
				order: 20,
				label: () => t("title"),
				locale: LOCALE_NS,
				inject: () => controller.inject()
			}, HttpProxySection))), "dsh-proxy: settings page");
		}
		//#endregion
		exports.LOCALE_NS = LOCALE_NS;
		exports.PI_AI_NS = PI_AI_NS;
		exports.SECTION_ID = SECTION_ID;
		exports.SECTION_ORDER = SECTION_ORDER;
		exports.SETTINGS_NS = SETTINGS_NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map