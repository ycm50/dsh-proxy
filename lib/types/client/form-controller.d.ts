/**
 * The dsh-proxy settings page's staged form over the `dsh-proxy` settings
 * namespace, plus the read-only `llm-pi-ai` view that supplies the known-host
 * pick list for the two host fields.
 *
 * DSH 0.1.7 owns the staging contract: `SettingsFormModel` (the same model the
 * bundled settings pages use) holds the drafts, derives each control's
 * effective value and overridden badge from the shared config form, and writes
 * every edit in one revision-fenced `mutate` on save. This module only says how
 * this plugin's four fields convert between stored values and draft text,
 * where the pick list comes from, and how the page reaches the Host half to ask
 * what proxy this machine is configured with.
 * @module dsh-proxy/client/form-controller
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { SettingsFieldState, SettingsFormActions, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client';
import type { SystemProxyReading } from '../rpc-contract.js';
/** The `dsh-proxy` section fields this page edits (the wire shape). */
export interface HttpProxySettings {
    /** Proxy URL (http/https/socks4/socks4a/socks5/socks5h); empty = inactive. */
    proxy?: string;
    /** Hostnames to proxy (empty = auto-detect every model host). */
    proxyHosts?: string[];
    /** Hostnames never proxied. */
    excludeHosts?: string[];
    /** Whether the machine's own proxy configuration supplies the address. */
    useSystemProxy?: boolean;
}
/** The `llm-pi-ai` section subset this page reads for known model gateways. */
export interface PiAiSettings {
    providers?: Record<string, {
        baseURL?: string;
    }>;
}
/** The two host-list fields, which share one control shape. */
export type HostFieldName = 'proxyHosts' | 'excludeHosts';
/** One editable field of the page. */
export type FieldName = 'proxy' | HostFieldName | 'useSystemProxy';
/** What the dsh-proxy settings page renders. */
export interface HttpProxyFormState extends SettingsFormShell {
    /** Staged proxy URL. */
    proxy: SettingsFieldState;
    /** Staged proxy-only hosts, comma/whitespace separated. */
    proxyHosts: SettingsFieldState;
    /** Staged excluded hosts, comma/whitespace separated. */
    excludeHosts: SettingsFieldState;
    /** Staged "use the system proxy" switch. */
    useSystemProxy: SettingsFieldState;
    /** Known model hostnames offered beside the host fields (free text still allowed). */
    suggestions: string[];
}
/** One answer to the page's "read the system proxy" request. */
export type SystemProxyRead = {
    status: 'ok';
    reading: SystemProxyReading;
} | {
    status: 'unavailable';
} | {
    status: 'failed';
    message: string;
};
/** The registration-side face the settings section injects. */
export interface HttpProxyFormFace extends SettingsFormActions {
    /** Form snapshot bound by the renderer as useHttpProxyForm. */
    hooks: {
        httpProxyForm: SnapshotStore<HttpProxyFormState>;
    };
    /**
     * Ask the Host half for this machine's proxy configuration. Never rejects:
     * a deployment without a Connection channel answers `unavailable`.
     */
    readSystemProxy(): Promise<SystemProxyRead>;
}
/** Bridges the `dsh-proxy` config form onto the settings page. */
export declare class HttpProxyFormController {
    private readonly ctx;
    private readonly scope;
    private readonly knownNs;
    private readonly form;
    private readonly mirror;
    private readonly store;
    private readonly disposers;
    /**
     * @param ctx - the browser plugin context, for the shared settings mirror.
     * @param scope - the shared config form of the `dsh-proxy` Host entry.
     * @param knownNs - namespace whose configured gateways feed the pick list.
     */
    constructor(ctx: ClientContext, scope: ConfigForm<HttpProxySettings>, knownNs: string);
    /** Stop observing the mirror and the form. Idempotent. */
    dispose(): void;
    /**
     * Build the face the section's slot registration injects.
     * @returns the page's snapshot and its form actions.
     */
    inject(): HttpProxyFormFace;
    /**
     * Ask the Host half what proxy this machine is configured with.
     *
     * The browser cannot read a registry, so the checkbox is a round trip: the
     * answer either carries a reading the page fills its field from, or says why
     * there is none. Nothing here throws — the page shows the failure and leaves
     * the form alone.
     * @returns the reading, or why there is none.
     */
    private readSystemProxy;
    private publish;
    private projection;
    /**
     * Hostnames offered by the host fields: the default DeepSeek host, the
     * built-in pi-ai catalog endpoints, every configured gateway, and what is
     * already saved.
     */
    private suggestions;
}
//# sourceMappingURL=form-controller.d.ts.map