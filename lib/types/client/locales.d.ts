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
export declare const en: {
    title: string;
    description: string;
    proxy: string;
    proxyHint: string;
    useSystemProxy: string;
    useSystemProxyHint: string;
    proxySubprocesses: string;
    proxySubprocessesHint: string;
    debugLog: string;
    debugLogHint: string;
    systemProxyReading: string;
    systemProxyDetected: string;
    systemProxyNone: string;
    systemProxyPac: string;
    systemProxyUnavailable: string;
    systemProxyFailed: string;
    systemProxyFromWindows: string;
    systemProxyFromEnv: string;
    systemProxyFromMacos: string;
    systemProxyFromLinux: string;
    systemProxyFromNone: string;
    connection: string;
    connectionHint: string;
    domains: string;
    domainsHint: string;
    force: string;
    forceHint: string;
    stability: string;
    stabilityHint: string;
    connectTimeoutMs: string;
    connectTimeoutMsHint: string;
    responseTimeoutMs: string;
    responseTimeoutMsHint: string;
    streamIdleTimeoutMs: string;
    streamIdleTimeoutMsHint: string;
    retryCount: string;
    retryCountHint: string;
    retryDelayMs: string;
    retryDelayMsHint: string;
    retryOnPossibleDelivery: string;
    retryOnPossibleDeliveryHint: string;
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