/**
 * The namespaces both halves of `dsh-http-proxy` agree on, and the props the
 * Settings panel binds for this plugin's page.
 *
 * Leaf module on purpose: `index.ts` (the plugin entry) and `section.tsx` (the
 * page component) both need these, and pointing either at the other would make
 * a load-order cycle out of a naming agreement.
 * @module dsh-http-proxy/client/contract
 */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { HttpProxyFormFace } from './form-controller.js';
import type { HttpProxyLocaleKey } from './locales.js';
/**
 * Settings namespace of this plugin — the Host-side profile entry id that
 * carries its config, and therefore the id the form is opened by. Kept in
 * sync with the `id` in `cordis.patch.yml`.
 */
export declare const SETTINGS_NS = "http-proxy";
/**
 * Key of this plugin's row in the Settings panel's left-hand navigation. The
 * section key drives `only` filtering, so it must be unique among sections;
 * `navIcon` in the shell gives an unrecognized key its default gear.
 */
export declare const SECTION_ID = "http-proxy";
/**
 * Navigation position. The bundled sections are `account` (-10), `general`
 * (0), `models` (10) and `plugins` (15); a network/transport preference reads
 * best after those rather than between two of them.
 */
export declare const SECTION_ORDER = 20;
/** The `llm-pi-ai` namespace, read-only here, supplying gateway hostname suggestions. */
export declare const PI_AI_NS = "llm-pi-ai";
/** Dictionary namespace owned by this plugin. */
export declare const LOCALE_NS = "settings.httpProxy";
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** Copy for the http-proxy settings page. */
        'settings.httpProxy': HttpProxyLocaleKey;
    }
}
/**
 * Props the renderer binds for the http-proxy page: the settings section's
 * owner share (`close`), the framework's standard kit, the locale `t` seat,
 * and this plugin's injected business face.
 */
export type HttpProxySectionProps = PropsRuntime<'settings.section'> & PropsLocale<typeof LOCALE_NS> & InjectFace<HttpProxyFormFace>;
/** The translate function of this plugin's dictionary. */
export type HttpProxyTranslate = HttpProxySectionProps['t'];
//# sourceMappingURL=contract.d.ts.map