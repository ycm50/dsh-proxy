/**
 * The one slice of the browser `connection` service this page calls: the
 * generic Connection RPC caller that reaches this plugin's Host half.
 *
 * The service is read through `ctx.get` rather than declared in the plugin's
 * `inject` list on purpose. Connection belongs to the wire root, which a
 * deployment may not compose at all, and this plugin must keep rendering its
 * page — and routing — without it; a missing caller is a page that reports it
 * cannot read the system proxy, not a plugin that fails to load.
 * @module dsh-proxy/client/connection
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type { RpcResult } from '../rpc-contract.js';
/** The generic Connection RPC caller the browser half exposes. */
export interface ClientRpcCaller {
    /**
     * Invoke one endpoint.
     * @param channel - the channel the endpoint belongs to.
     * @param endpoint - the method name within that channel.
     * @param payload - endpoint-owned request value.
     * @param signal - optional cancellation.
     * @returns the endpoint's value or failure envelope.
     */
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult<unknown>>;
}
/** The browser `connection` service, as far as this page needs it. */
export interface ClientConnectionService {
    /** The generic RPC caller; absent on a carrier that offers none. */
    rpc?: ClientRpcCaller;
}
/**
 * Read the browser `connection` service's RPC caller.
 *
 * Called per request rather than cached: Connection may be provided after this
 * plugin loads, and a deployment that never provides it leaves the caller
 * undefined.
 * @param ctx - the browser plugin context.
 * @returns the caller, or undefined when this deployment has no Connection.
 */
export declare function clientRpc(ctx: ClientContext): ClientRpcCaller | undefined;
//# sourceMappingURL=connection.d.ts.map