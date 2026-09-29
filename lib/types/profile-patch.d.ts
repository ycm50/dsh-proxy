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
/** One `id`/`name` pair this plugin has been mounted under. */
export interface ProxyIdentity {
    /** The profile entry id. */
    readonly id: string;
    /** The package name the row's `name:` must carry. */
    readonly name: string;
}
/** The profile entry id this plugin mounts as today (its package name too). */
export declare const PROXY_ENTRY_ID = "dsh-proxy";
/** The package name a row must carry to count as this plugin's own. */
export declare const PROXY_PACKAGE_NAME = "dsh-proxy";
/**
 * Every identity this plugin has ever been mounted under.
 *
 * `http-proxy` / `dsh-http-proxy` is what releases up to 0.2.x used; a row
 * left behind by one of those is still this plugin's residue, so it is
 * cleaned like the current one.
 */
export declare const PROXY_IDENTITIES: readonly ProxyIdentity[];
/** The profile patch file DSH applies after every bundle layer. */
export declare const PROFILE_PATCH_FILE = "cordis.patch.yml";
/** The profile manifest that names the bundles a profile selects. */
export declare const PROFILE_MANIFEST_FILE = "package.json";
/** What one textual prune did to the patch text. */
export interface PatchPruneResult {
    /** Whether a row was dropped (the text is unchanged otherwise). */
    readonly changed: boolean;
    /** The resulting text: the input verbatim when nothing matched. */
    readonly text: string;
    /** `removed` when the row went, `absent` when the file carries no such row. */
    readonly reason: 'removed' | 'absent';
    /** The entry id whose row went, for the log line. */
    readonly id?: string;
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
export declare function pruneProxyEntry(text: string, identities?: readonly ProxyIdentity[]): PatchPruneResult;
/** How the profile's patch describes this plugin's row. */
export type ProxyRowState = 'absent' | 'enabled' | 'disabled';
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
export declare function readProxyEntryState(text: string, identities?: readonly ProxyIdentity[]): ProxyRowState;
/** What one textual config strip did. */
export interface PatchStripResult {
    /** Whether the `config:` block was dropped (the text is unchanged otherwise). */
    readonly changed: boolean;
    /** The resulting text: the input verbatim when nothing was dropped. */
    readonly text: string;
    /** `stripped`; `no-config` when the row carries no `config:`; `absent` when there is no row. */
    readonly reason: 'stripped' | 'no-config' | 'absent';
    /** The entry id whose row was rewritten (absent when no row matched). */
    readonly id?: string;
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
export declare function stripProxyEntryConfig(text: string, identities?: readonly ProxyIdentity[]): PatchStripResult;
/** Whether the profile still selects a bundle that mounts this plugin. */
export type BundleSelection = 'selected' | 'deselected' | 'unknown';
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
export declare function readBundleSelection(env?: NodeJS.ProcessEnv): BundleSelection;
/**
 * The profile directory this process runs in.
 *
 * `DSH_PROFILE_DIR` is the authoritative answer; `DSH_HOME` plus
 * `DSH_PROFILE` is the documented layout, and `~/.dsh/profiles/desktop` is the
 * last resort so a plain `dsh` run still finds its profile.
 * @param env - the environment to read (defaults to this process's).
 * @returns the absolute profile directory.
 */
export declare function profileDir(env?: NodeJS.ProcessEnv): string;
/**
 * The profile patch this process's profile owns.
 * @param env - the environment to read (defaults to this process's).
 * @returns the absolute path of the profile's `cordis.patch.yml`.
 */
export declare function profilePatchPath(env?: NodeJS.ProcessEnv): string;
/**
 * The profile manifest this process's profile owns.
 * @param env - the environment to read (defaults to this process's).
 * @returns the absolute path of the profile's `package.json`.
 */
export declare function profileManifestPath(env?: NodeJS.ProcessEnv): string;
/** What one cleanup pass over the profile patch did. */
export interface ProxyRowCleanup {
    /** The patch file the pass looked at. */
    readonly file: string;
    /** Whether this plugin's row was dropped. */
    readonly removed: boolean;
    /** Why it ended the way it did: `removed`/`stripped`, `no-row`/`no-config`, `no-patch-file`, `write-failed: …`. */
    readonly reason: string;
    /** The entry id whose row went (absent when nothing matched). */
    readonly id?: string;
}
/**
 * Drop this plugin's row from the profile patch on disk.
 *
 * Never throws: a settings row is not worth failing a plugin mount over, so a
 * missing file or an unwritable profile comes back as a reason instead.
 * @param env - the environment to resolve the profile from.
 * @returns the file it touched and whether the row went.
 */
export declare function pruneProxyEntryFromProfile(env?: NodeJS.ProcessEnv): ProxyRowCleanup;
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
export declare function planRowCleanup(vacant: boolean, env?: NodeJS.ProcessEnv): {
    mode: 'remove' | 'strip-config';
    reason: string;
} | undefined;
/**
 * Drop this plugin's settings from the profile patch on disk, keeping the row
 * and its other keys (see {@link stripProxyEntryConfig}).
 *
 * Never throws, for the same reason {@link pruneProxyEntryFromProfile} does
 * not: a stale settings row is not worth failing an unload over.
 * @param env - the environment to resolve the profile from.
 * @returns the file it touched and whether the settings went.
 */
export declare function stripProxyEntryConfigFromProfile(env?: NodeJS.ProcessEnv): ProxyRowCleanup;
//# sourceMappingURL=profile-patch.d.ts.map