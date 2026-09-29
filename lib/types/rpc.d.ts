/**
 * The Host half of the system-proxy wire: one exact Fetch route on
 * Connection's browser carrier, answering with this machine's proxy
 * configuration.
 *
 * The browser half cannot read a registry, so the checkbox asks the Host and
 * fills the form from the answer. Connection owns the transport (`/api`, its
 * Host/Origin fence, browser authentication, and the request bridge), so this
 * module answers one route and owns the registration's lifetime; it never
 * touches a socket or a session.
 *
 * A route rather than a channel of our own on purpose: Connection's channel
 * registry resolves `webServer` against the *service's* own fiber, which does
 * not inject it, so only registrations that stay inside the service's own
 * route table (`fetch.register`) are reachable. The route lives under `/api`
 * because that is the carrier that consults that table.
 *
 * The whole registration is optional. A composition without Connection — a
 * headless run, an SDK host — simply has no browser page to serve, and the
 * routing half never depended on the wire.
 * @module dsh-proxy/rpc
 */
import type { Context } from '@deepseek-ai/cordis';
/**
 * Serve {@link SYSTEM_PROXY_ROUTE} on Connection's browser carrier.
 *
 * The registration follows the `connection` service: it is installed when the
 * service appears and withdrawn with this plugin's fiber.
 * @param ctx - the Host plugin context to hang the route under.
 */
export declare function installSystemProxyRpc(ctx: Context): void;
//# sourceMappingURL=rpc.d.ts.map