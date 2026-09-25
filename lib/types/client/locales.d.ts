/**
 * Locale bundles for the http-proxy settings card.
 *
 * Both shipped languages are required together by `ctx.locale.register`, and
 * the key sets are checked against the namespace declaration in
 * `contract.ts` — so a key added to one dictionary and forgotten in the other
 * is a compile error rather than a raw key on screen.
 * @module dsh-http-proxy/client/locales
 */
/** English copy. */
export declare const en: {
    title: string;
    description: string;
    proxy: string;
    proxyHint: string;
    hosts: string;
    hostsHint: string;
    exclude: string;
    excludeHint: string;
    suggestions: string;
    suggestionsHint: string;
    suggestionsEmpty: string;
    overridden: string;
    reset: string;
    invalid: string;
    readOnly: string;
    unavailable: string;
    save: string;
    saving: string;
    saveFailed: string;
};
/** Simplified Chinese copy. */
export declare const zh: Record<keyof typeof en, string>;
/** Key domain of this plugin's dictionary. */
export type HttpProxyLocaleKey = keyof typeof en;
//# sourceMappingURL=locales.d.ts.map