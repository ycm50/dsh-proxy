/**
 * Client half of dsh-http-proxy: registers the `http-proxy` page in the
 * Settings panel's left-hand navigation, over the same `http-proxy` settings
 * namespace the Host half serves.
 *
 * DSH 0.1.7 split this apart. The panel's navigation is a list slot the
 * settings shell declares and projects into nav rows (`settings.section`),
 * and the form is reached through the settings domain's `configForms` service
 * rather than a namespace binding of this plugin's own. Registration is
 * guarded by `whileServed`, so a deployment that never composed the Host half
 * shows no row — the same discipline the bundled pages use.
 * @module dsh-http-proxy/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
export { LOCALE_NS, PI_AI_NS, SECTION_ID, SECTION_ORDER, SETTINGS_NS } from './contract.js';
/** Required services (cordis fiber inject). */
export declare const inject: string[];
/**
 * Mount the http-proxy settings page.
 * @param ctx - the browser plugin context.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map