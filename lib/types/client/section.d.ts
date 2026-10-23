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
import type { ReactElement } from 'react';
import type { HttpProxySectionProps } from './contract.js';
/**
 * Render the dsh-proxy settings page.
 * @param props - locale copy, the page snapshot, and its form actions.
 * @returns the page column.
 */
export declare function HttpProxySection(props: HttpProxySectionProps): ReactElement;
//# sourceMappingURL=section.d.ts.map