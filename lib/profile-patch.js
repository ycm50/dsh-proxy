import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
//#region src/profile-patch.ts
/**
* Self-cleanup for this plugin's own row in the profile patch layer.
*
* DSH persists a plugin's settings as an id-targeted row in the profile's
* `cordis.patch.yml`, and nothing takes that row back out when the plugin goes
* away: switching it off, or uninstalling it, only drops its bundle, so the row
* outlives the entry it configured and the profile stops looking clean. This
* module owns the reverse direction, and reads the two facts that decide how
* far it may go — whether the profile still selects this plugin's bundle, and
* whether DSH marked the row `disabled: true` (see {@link planRowCleanup}).
* Every rewrite is textual: it touches only this plugin's row, and leaves every
* other entry, comment, and `!!js` expression byte-for-byte alone.
*
* The rewrite is textual on purpose. The profile patch is YAML whose comments
* and `!!js` expressions must survive, and a parse/serialize round-trip would
* rewrite them. Only the matched row's lines are dropped; everything else is
* copied verbatim, and the replacement lands through a temp file plus rename
* so a crash cannot leave a half-written patch behind.
* @module dsh-proxy/profile-patch
*/
/** The profile entry id this plugin mounts as today (its package name too). */
const PROXY_ENTRY_ID = "dsh-proxy";
/** The package name a row must carry to count as this plugin's own. */
const PROXY_PACKAGE_NAME = "dsh-proxy";
/**
* Every identity this plugin has ever been mounted under.
*
* `http-proxy` / `dsh-http-proxy` is what releases up to 0.2.x used; a row
* left behind by one of those is still this plugin's residue, so it is
* cleaned like the current one.
*/
const PROXY_IDENTITIES = [{
	id: PROXY_ENTRY_ID,
	name: PROXY_PACKAGE_NAME
}, {
	id: "http-proxy",
	name: "dsh-http-proxy"
}];
/** The profile patch file DSH applies after every bundle layer. */
const PROFILE_PATCH_FILE = "cordis.patch.yml";
/** The profile manifest that names the bundles a profile selects. */
const PROFILE_MANIFEST_FILE = "package.json";
/** The `disabled:` key inside a row's mapping. */
const DISABLED_RE = /^[ \t]+disabled:[ \t]*(\S+)/;
/** The `config:` key inside a row's mapping. */
const CONFIG_RE = /^([ \t]+)config:[ \t]*(?:#.*)?$/;
/** A sequence item carrying an `id:` key, at any indentation. */
const ITEM_RE = /^([ \t]*)-[ \t]+id:[ \t]*['"]?([^'"\s#]+)['"]?[ \t]*(?:#.*)?$/;
/** A `name:` key inside a sequence item's mapping. */
const NAME_RE = /^[ \t]+name:[ \t]*['"]?([^'"\s#]+)['"]?[ \t]*(?:#.*)?$/;
/** An `insert:` sequence item, which owns nested rows. */
const INSERT_RE = /^([ \t]*)-[ \t]+insert:[ \t]*(?:#.*)?$/;
/** A nested sequence item, as `insert:` children are spelled. */
const NESTED_ITEM_RE = /^[ \t]*-[ \t]/;
/** Count a line's leading whitespace characters (both indent styles). */
function leadingWidth(line) {
	let width = 0;
	while (width < line.length && (line[width] === " " || line[width] === "	")) width += 1;
	return width;
}
/**
* The line that ends a block belonging to the item at `start`.
*
* A block runs over blank lines and over every line indented deeper than the
* item; the first non-blank line at the item's own indentation or shallower
* belongs to the next item (or to the parent), and ends the block.
* @param lines - the patch file's lines.
* @param start - the owning item's line index.
* @param indent - the owning item's indentation.
* @returns the exclusive end index of the block.
*/
function blockEnd(lines, start, indent) {
	let end = start + 1;
	while (end < lines.length) {
		const line = lines[end] ?? "";
		if (line.trim().length === 0) {
			end += 1;
			continue;
		}
		if (leadingWidth(line) > indent) {
			end += 1;
			continue;
		}
		break;
	}
	return end;
}
/**
* The `insert:` item that owns a nested row, if the row is nested at all.
* @param lines - the patch file's lines.
* @param itemIndex - the nested row's line index.
* @param itemIndent - the nested row's indentation.
* @returns the owner's line index and indentation, or `undefined` for a top-level row.
*/
function owningInsert(lines, itemIndex, itemIndent) {
	for (let index = itemIndex - 1; index >= 0; index -= 1) {
		const line = lines[index] ?? "";
		if (line.trim().length === 0) continue;
		const width = leadingWidth(line);
		if (width >= itemIndent) continue;
		return INSERT_RE.exec(line) !== null ? {
			index,
			indent: width
		} : void 0;
	}
}
/**
* Whether an `insert:` block still holds any child row.
* @param lines - the patch file's lines.
* @param ownerIndex - the `insert:` item's line index.
* @param ownerIndent - the `insert:` item's indentation.
* @returns `true` while at least one nested sequence item remains.
*/
function insertHasChildren(lines, ownerIndex, ownerIndent) {
	for (let index = ownerIndex + 1; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (line.trim().length === 0) continue;
		if (leadingWidth(line) <= ownerIndent) return false;
		if (NESTED_ITEM_RE.test(line)) return true;
	}
	return false;
}
/**
* Remove this plugin's row from profile-patch text.
*
* A row is matched on its `id:` and confirmed by its `name:` — a row that
* names a different package under the same id is left alone, so a future DSH
* entry reusing one of these ids is never touched. A row nested inside an
* `insert:` list takes that list with it when it was the last child, because
* an empty `insert:` would otherwise be a null where DSH expects a list.
* @param text - the whole `cordis.patch.yml` text.
* @param identities - the `id`/`name` pairs counted as this plugin's own.
* @returns the pruned text and whether anything was removed.
*/
function pruneProxyEntry(text, identities = PROXY_IDENTITIES) {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(/\r?\n/);
	const trailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
	if (trailingNewline) lines.pop();
	for (let index = 0; index < lines.length; index += 1) {
		const item = ITEM_RE.exec(lines[index] ?? "");
		if (item === null) continue;
		const identity = identities.find((candidate) => candidate.id === item[2]);
		if (identity === void 0) continue;
		const indent = (item[1] ?? "").length;
		const end = blockEnd(lines, index, indent);
		let named;
		for (let cursor = index + 1; cursor < end; cursor += 1) {
			const match = NAME_RE.exec(lines[cursor] ?? "");
			if (match !== null) {
				named = match[1];
				break;
			}
		}
		if (named !== void 0 && named !== identity.name) continue;
		const owner = owningInsert(lines, index, indent);
		let kept = [...lines.slice(0, index), ...lines.slice(end)];
		if (owner !== void 0 && !insertHasChildren(kept, owner.index, owner.indent)) kept = [...kept.slice(0, owner.index), ...kept.slice(blockEnd(kept, owner.index, owner.indent))];
		if (kept.every((line) => line.trim().length === 0)) return {
			changed: true,
			text: `[]${eol}`,
			reason: "removed",
			id: identity.id
		};
		return {
			changed: true,
			text: kept.join(eol) + (trailingNewline ? eol : ""),
			reason: "removed",
			id: identity.id
		};
	}
	return {
		changed: false,
		text,
		reason: "absent"
	};
}
/**
* Locate this plugin's row in patch text.
*
* The match is the same one the prune uses: the row's `id` must be one of this
* plugin's own, and a row that names a different package under that id is
* someone else's and is never reported.
* @param lines - the patch file's lines.
* @param identities - the `id`/`name` pairs counted as this plugin's own.
* @returns the row's location, or undefined when there is none.
*/
function findProxyRow(lines, identities) {
	for (let index = 0; index < lines.length; index += 1) {
		const item = ITEM_RE.exec(lines[index] ?? "");
		if (item === null) continue;
		const identity = identities.find((candidate) => candidate.id === item[2]);
		if (identity === void 0) continue;
		const indent = (item[1] ?? "").length;
		const end = blockEnd(lines, index, indent);
		let named;
		for (let cursor = index + 1; cursor < end; cursor += 1) {
			const match = NAME_RE.exec(lines[cursor] ?? "");
			if (match !== null) {
				named = match[1];
				break;
			}
		}
		if (named !== void 0 && named !== identity.name) continue;
		return {
			index,
			indent,
			end,
			id: identity.id
		};
	}
}
/**
* Read whether this plugin's row is present, and whether it is switched off.
*
* `disabled: true` is how DSH's own plugin manager turns one entry off — it
* writes that key into this row — so it is the signal that separates "the user
* switched this plugin off" from "the loader recomposed it".
* @param text - the whole `cordis.patch.yml` text.
* @param identities - the `id`/`name` pairs counted as this plugin's own.
* @returns the row's state.
*/
function readProxyEntryState(text, identities = PROXY_IDENTITIES) {
	const lines = text.split(/\r?\n/);
	const row = findProxyRow(lines, identities);
	if (row === void 0) return "absent";
	for (let cursor = row.index + 1; cursor < row.end; cursor += 1) {
		const match = DISABLED_RE.exec(lines[cursor] ?? "");
		if (match === null) continue;
		const value = (match[1] ?? "").toLowerCase();
		return value === "true" || value === "yes" || value === "on" || value === "1" ? "disabled" : "enabled";
	}
	return "enabled";
}
/**
* Drop this plugin's `config:` block while keeping the row and its other keys.
*
* A row that carries `disabled: true` cannot simply be deleted: the entry is
* inserted by this plugin's own bundle, so removing the override would let it
* run again on the next composition. Taking only the settings out leaves DSH's
* own "off" marker in place with nothing of this plugin's left in the file.
* @param text - the whole `cordis.patch.yml` text.
* @param identities - the `id`/`name` pairs counted as this plugin's own.
* @returns the rewritten text and what it did.
*/
function stripProxyEntryConfig(text, identities = PROXY_IDENTITIES) {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(/\r?\n/);
	const trailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
	if (trailingNewline) lines.pop();
	const row = findProxyRow(lines, identities);
	if (row === void 0) return {
		changed: false,
		text,
		reason: "absent"
	};
	for (let cursor = row.index + 1; cursor < row.end; cursor += 1) {
		const match = CONFIG_RE.exec(lines[cursor] ?? "");
		if (match === null) continue;
		const configIndent = (match[1] ?? "").length;
		let start = cursor;
		while (start > row.index + 1 && (lines[start - 1] ?? "").trim().length === 0) start -= 1;
		return {
			changed: true,
			text: [...lines.slice(0, start), ...lines.slice(blockEnd(lines, cursor, configIndent))].join(eol) + (trailingNewline ? eol : ""),
			reason: "stripped",
			id: row.id
		};
	}
	return {
		changed: false,
		text,
		reason: "no-config",
		id: row.id
	};
}
/**
* Read whether the profile's selected bundles still include this plugin.
*
* A bundle that is no longer selected contributes no patch layer, so its entry
* is never composed and the settings row is dead weight DSH can only warn
* about. `unknown` — no readable manifest, or no `dsh.profile.bundles` —
* leaves the decision to the other signals.
* @param env - the environment to resolve the profile from.
* @returns the selection state.
*/
function readBundleSelection(env = process.env) {
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(profileManifestPath(env), "utf8"));
	} catch {
		return "unknown";
	}
	const bundles = manifest?.dsh?.profile?.bundles;
	if (!Array.isArray(bundles)) return "unknown";
	const names = new Set(PROXY_IDENTITIES.map((identity) => identity.name));
	return bundles.some((name) => typeof name === "string" && names.has(name)) ? "selected" : "deselected";
}
/**
* The profile directory this process runs in.
*
* `DSH_PROFILE_DIR` is the authoritative answer; `DSH_HOME` plus
* `DSH_PROFILE` is the documented layout, and `~/.dsh/profiles/desktop` is the
* last resort so a plain `dsh` run still finds its profile.
* @param env - the environment to read (defaults to this process's).
* @returns the absolute profile directory.
*/
function profileDir(env = process.env) {
	const home = env.DSH_HOME !== void 0 && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(homedir(), ".dsh");
	const profile = env.DSH_PROFILE !== void 0 && env.DSH_PROFILE.length > 0 ? env.DSH_PROFILE : "desktop";
	return env.DSH_PROFILE_DIR !== void 0 && env.DSH_PROFILE_DIR.length > 0 ? env.DSH_PROFILE_DIR : join(home, "profiles", profile);
}
/**
* The profile patch this process's profile owns.
* @param env - the environment to read (defaults to this process's).
* @returns the absolute path of the profile's `cordis.patch.yml`.
*/
function profilePatchPath(env = process.env) {
	return join(profileDir(env), PROFILE_PATCH_FILE);
}
/**
* The profile manifest this process's profile owns.
* @param env - the environment to read (defaults to this process's).
* @returns the absolute path of the profile's `package.json`.
*/
function profileManifestPath(env = process.env) {
	return join(profileDir(env), PROFILE_MANIFEST_FILE);
}
/**
* Drop this plugin's row from the profile patch on disk.
*
* Never throws: a settings row is not worth failing a plugin mount over, so a
* missing file or an unwritable profile comes back as a reason instead.
* @param env - the environment to resolve the profile from.
* @returns the file it touched and whether the row went.
*/
function pruneProxyEntryFromProfile(env = process.env) {
	const file = profilePatchPath(env);
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return {
			file,
			removed: false,
			reason: "no-patch-file"
		};
	}
	const pruned = pruneProxyEntry(text);
	if (!pruned.changed) return {
		file,
		removed: false,
		reason: "no-row"
	};
	const staging = `${file}.${process.pid}.prune.tmp`;
	try {
		writeFileSync(staging, pruned.text, "utf8");
		renameSync(staging, file);
	} catch (cause) {
		try {
			unlinkSync(staging);
		} catch {}
		return {
			file,
			removed: false,
			reason: `write-failed: ${cause instanceof Error ? cause.message : String(cause)}`
		};
	}
	return pruned.id === void 0 ? {
		file,
		removed: true,
		reason: "removed"
	} : {
		file,
		removed: true,
		reason: "removed",
		id: pruned.id
	};
}
/**
* Explain why the row in a profile patch should go when the plugin unloads.
*
* An unload alone says nothing: the same teardown runs for a restart, an HMR
* reload, an update, and a switch-off. What separates them is the profile's own
* persistent state, so this reads it:
*
* - the profile manifest no longer selects this plugin's bundle — DSH's own
*   "switched off" and "uninstalled" state, and with no bundle layer there is
*   no entry left for the row to configure: the row goes entirely;
* - the row itself carries `disabled: true` — DSH switched this one entry off
*   while its bundle stays selected, so deleting the override would re-enable
*   the entry the bundle inserts: the settings go and the marker stays;
* - otherwise the unload is not a switch-off, and the row is left alone (a
*   reload must not cost the user their settings).
* @param vacant - whether the live configuration carried nothing.
* @param env - the environment to resolve the profile from.
* @returns the action to take, or undefined to leave the row alone.
*/
function planRowCleanup(vacant, env = process.env) {
	if (readBundleSelection(env) === "deselected") return {
		mode: "remove",
		reason: "the profile no longer selects this plugin bundle"
	};
	let text;
	try {
		text = readFileSync(profilePatchPath(env), "utf8");
	} catch {
		text = "";
	}
	if (readProxyEntryState(text) === "disabled") return {
		mode: "strip-config",
		reason: "the profile switches this plugin entry off"
	};
	if (vacant) return {
		mode: "remove",
		reason: "unloaded with empty settings"
	};
}
/**
* Drop this plugin's settings from the profile patch on disk, keeping the row
* and its other keys (see {@link stripProxyEntryConfig}).
*
* Never throws, for the same reason {@link pruneProxyEntryFromProfile} does
* not: a stale settings row is not worth failing an unload over.
* @param env - the environment to resolve the profile from.
* @returns the file it touched and whether the settings went.
*/
function stripProxyEntryConfigFromProfile(env = process.env) {
	const file = profilePatchPath(env);
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return {
			file,
			removed: false,
			reason: "no-patch-file"
		};
	}
	const stripped = stripProxyEntryConfig(text);
	if (!stripped.changed) return {
		file,
		removed: false,
		reason: stripped.reason
	};
	const staging = `${file}.${process.pid}.prune.tmp`;
	try {
		writeFileSync(staging, stripped.text, "utf8");
		renameSync(staging, file);
	} catch (cause) {
		try {
			unlinkSync(staging);
		} catch {}
		return {
			file,
			removed: false,
			reason: `write-failed: ${cause instanceof Error ? cause.message : String(cause)}`
		};
	}
	return stripped.id === void 0 ? {
		file,
		removed: true,
		reason: stripped.reason
	} : {
		file,
		removed: true,
		reason: stripped.reason,
		id: stripped.id
	};
}
//#endregion
export { PROFILE_MANIFEST_FILE, PROFILE_PATCH_FILE, PROXY_ENTRY_ID, PROXY_IDENTITIES, PROXY_PACKAGE_NAME, planRowCleanup, profileDir, profileManifestPath, profilePatchPath, pruneProxyEntry, pruneProxyEntryFromProfile, readBundleSelection, readProxyEntryState, stripProxyEntryConfig, stripProxyEntryConfigFromProfile };
