/**
 * Self-cleanup for this plugin's own row in the profile patch layer.
 *
 * DSH persists a plugin's settings as an id-targeted row in the profile's
 * `cordis.patch.yml`, and nothing takes that row back out when the settings
 * return to "nothing configured": disabling or uninstalling the plugin only
 * drops its bundle, so the row outlives it and the profile stops looking
 * clean. This module owns the reverse direction — it finds this plugin's row
 * and removes it, leaving every other entry byte-for-byte alone.
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
/**
 * The profile patch this process's profile owns.
 *
 * `DSH_PROFILE_DIR` is the authoritative answer; `DSH_HOME` plus
 * `DSH_PROFILE` is the documented layout, and `~/.dsh/profiles/desktop` is the
 * last resort so a plain `dsh` run still finds its patch.
 * @param env - the environment to read (defaults to this process's).
 * @returns the absolute path of the profile's `cordis.patch.yml`.
 */
export declare function profilePatchPath(env?: NodeJS.ProcessEnv): string;
/** What one cleanup pass over the profile patch did. */
export interface ProxyRowCleanup {
    /** The patch file the pass looked at. */
    readonly file: string;
    /** Whether this plugin's row was dropped. */
    readonly removed: boolean;
    /** Why it ended the way it did: `removed`, `no-row`, `no-patch-file`, `write-failed: …`. */
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
