/**
 * The wire this plugin's two halves share for "read the operating system's
 * proxy" requests: the Connection channel and endpoint it serves, and the
 * result shape both sides agree on.
 *
 * Leaf module on purpose — the Host half registers the route and the browser
 * half calls it, and pointing either at the other would make the browser
 * bundle pull in the Host half's `node:` imports. Nothing here may import
 * `node:*` or any package.
 * @module dsh-proxy/rpc-contract
 */
/**
 * The Connection channel this plugin's endpoint lives on.
 *
 * It is Connection's shared browser carrier, not a channel of our own:
 * Connection registers one web-server prefix per channel, and the registry
 * its own service exposes can only add an exact Fetch route *under* `/api`.
 * The channel brings the Host/Origin fence and browser authentication with it,
 * which is why the endpoint does not have to implement either.
 */
export declare const SYSTEM_PROXY_CHANNEL = "/api";
/**
 * The endpoint this plugin serves on {@link SYSTEM_PROXY_CHANNEL}.
 *
 * Connection's own callers spell an endpoint as `<namespace>/<method>`, and a
 * route path is the channel plus that endpoint, so the browser reaches this
 * plugin at `/api/dsh-proxy/system-proxy`.
 */
export declare const SYSTEM_PROXY_ENDPOINT = "dsh-proxy/system-proxy";
/** The exact web-server path of this plugin's endpoint. */
export declare const SYSTEM_PROXY_ROUTE = "/api/dsh-proxy/system-proxy";
/**
 * Which mechanism supplied a reading.
 *
 * The browser turns this into user-facing copy, so a new member here wants a
 * matching dictionary entry on both shipped locales.
 */
export type SystemProxySource = 'windows-registry' | 'env' | 'macos-scutil' | 'linux-gsettings' | 'none';
/** One answer to "what proxy does this machine use?". */
export interface SystemProxyReading {
    /**
     * Normalized proxy URL, ready for the form's `proxy` field
     * (`http://127.0.0.1:10808`). Empty means the machine configures none this
     * plugin can use.
     */
    proxy: string;
    /** Which mechanism produced {@link proxy}. */
    source: SystemProxySource;
    /**
     * One-line English summary for logs. User-facing copy is composed in the
     * browser from the structured fields instead, so both shipped locales stay
     * translatable.
     */
    detail: string;
    /** The platform the reading came from: `win32`, `darwin`, `linux`, or `unknown`. */
    platform: string;
    /**
     * The system's auto-config (PAC) URL, when it uses one. This plugin cannot
     * resolve a PAC script, so a system whose only configuration is a PAC URL
     * reports an empty {@link proxy} plus this fact.
     */
    pacUrl?: string;
}
/** Generic endpoint failure carried in a Connection response envelope. */
export interface RpcFailure {
    /** Stable machine-readable code; endpoint-owned. */
    code: string;
    /** Human-readable message. */
    message: string;
    /** Extra structured detail; endpoint-owned. */
    details: Record<string, unknown>;
}
/** One Connection RPC answer: a value or a failure, never a rejection. */
export type RpcResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: RpcFailure;
};
/** One unary request as Connection's browser caller writes it. */
export interface ClientRequestEnvelope {
    /** Discriminator Connection's own parser requires. */
    type: 'client-request';
    /** Correlation id echoed back in the response. */
    rpcId: string;
    /** The endpoint being called; must match the route the request arrived on. */
    method: string;
    /** Endpoint-owned request value. */
    payload: unknown;
}
/** One unary answer, in the shape Connection's browser caller parses. */
export interface ServerResponseEnvelope<T> {
    /** Discriminator Connection's own parser requires. */
    type: 'server-response';
    /** The request's correlation id. */
    rpcId: string;
    /** The endpoint's answer. */
    result: RpcResult<T>;
}
//# sourceMappingURL=rpc-contract.d.ts.map