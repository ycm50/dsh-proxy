/**
 * The process-wide dispatch layer: one `RoutingDispatcher` that decides, per
 * request, which of two channels carries it — the hardened direct channel for
 * everything the configuration does not name, the hardened proxy channel for
 * the hosts it does name. Exemptions (loopback, private networks, and the
 * user's own `excludeHosts`) outrank the routed list, so a name that must not
 * travel cannot be made to.
 *
 * Why install this as the *global* dispatcher and not only wrap
 * `globalThis.fetch`: a library may capture `fetch`, call `undici.request`, or hold
 * a dispatcher reference from before this plugin mounted. Node's built-in
 * `fetch` resolves `getGlobalDispatcher()` per request and undici's global slot is
 * a shared `Symbol.for(...)`, so replacing it covers those callers too.
 * Verified in the harness's own runtime (Electron 44 / Node 24.18 / undici
 * 7.30): a dummy proxy installed here made the built-in fetch fail with
 * ECONNREFUSED, and restoring put the original back.
 *
 * Multi-instance safety mirrors the fetch-wrapper stack in `index.ts`: live
 * installs are remembered alongside the dispatcher that preceded them all, a
 * retire only re-points the global while it is still one of ours, and the
 * machine's own dispatcher comes back when the last install goes. The global
 * slot is defined `configurable: false` by undici, so restoration is an
 * assignment and never a delete.
 * @module dsh-proxy/dispatch
 */
import { Dispatcher } from 'undici';
import { isExemptHostname } from './proxy.js';
import type { DispatchRecord } from './routing.js';
export { isExemptHostname };
/** One channel pair plus the per-hostname choice between them. */
export interface RoutingInput {
    /** Channel for every request the choice does not send through the proxy. */
    direct: Dispatcher;
    /** Channel for hosts the configuration names. */
    proxied: Dispatcher;
    /** Whether one hostname travels through the proxy (exemptions already applied). */
    proxyFor(hostname: string): boolean;
    /**
     * Whether this hostname's channel may move at all.
     *
     * A pinned host is always proxied and a loopback/LAN name is always direct, so
     * neither has a cursor to move; only the hosts in between are observed.
     */
    rotateFor?(hostname: string): boolean;
    /**
     * Where each dispatched request's outcome is reported.
     *
     * The dispatcher is the layer that serves callers which captured `fetch`
     * before this plugin mounted, so it has to move the same cursor the wrapped
     * path moves — otherwise those callers retry on one channel forever.
     */
    onOutcome?(record: DispatchRecord): void;
}
/**
 * A dispatcher that routes one request by its origin.
 *
 * Forwarding is deliberately field-for-field: a dispatcher sits between a
 * caller and a socket, so anything rewritten here would be invisible to both.
 * A malformed origin takes the direct channel rather than throwing — fail-open,
 * so this plugin can never be the reason a request that used to work stopped
 * working.
 *
 * Teardown closes both channels and never destroys them, so an in-flight
 * streaming response finishes instead of being cut off by an unload.
 */
export declare class RoutingDispatcher extends Dispatcher {
    private readonly input;
    constructor(input: RoutingInput);
    /** @inheritdoc */
    dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean;
    /** Close both channels, waiting for in-flight requests. */
    close(callback: () => void): void;
    close(): Promise<void>;
    /** Destroy both channels immediately, dropping in-flight requests. */
    destroy(err: Error | null, callback: () => void): void;
    destroy(callback: () => void): void;
    destroy(err: Error | null): Promise<void>;
    destroy(): Promise<void>;
}
/**
 * Publish a routing dispatcher as the process-wide one.
 * @param token - the installing instance's handle, for uninstallGlobalDispatcher.
 * @param dispatcher - the routing dispatcher to install.
 */
export declare function installGlobalDispatcher(token: symbol, dispatcher: Dispatcher): void;
/**
 * Retire one install, re-pointing the global at the newest live one — or back
 * at the dispatcher that preceded them all when none is left.
 *
 * The global is only touched while it is still one of ours: another plugin may
 * have replaced it since, and that replacement is not this module's to undo.
 * @param token - the handle installGlobalDispatcher was called with.
 * @returns whether the install was still held.
 */
export declare function uninstallGlobalDispatcher(token: symbol): boolean;
/** How many installs this module currently holds (tests reach for it). */
export declare function liveDispatcherCount(): number;
//# sourceMappingURL=dispatch.d.ts.map