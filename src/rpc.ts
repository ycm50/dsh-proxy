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

import type { Context } from '@deepseek-ai/cordis'
import { SYSTEM_PROXY_ENDPOINT, SYSTEM_PROXY_ROUTE } from './rpc-contract.js'
import type { ClientRequestEnvelope, RpcFailure, RpcResult, SystemProxyReading } from './rpc-contract.js'
import { readSystemProxy } from './system-proxy.js'

/** The correlation id Connection itself uses when a request cannot be parsed. */
const INVALID_RPC_ID = 'invalid-request'

/** One exact Fetch route, in the shape Connection stores it. */
interface FetchRoute {
  /** Absolute pathname the route answers on. */
  path: string
  /** HTTP methods the route claims. */
  methods: string[]
  /** Whether Connection buffers the body before calling {@link fetch}. */
  requestBody: 'buffered' | 'streaming'
  /** Answer one request. */
  fetch(request: Request): Promise<Response>
}

/** The exact-route registry Connection's Host service exposes. */
interface ConnectionFetchRegistry {
  /** Register one route; returns the disposer that withdraws it. */
  register(route: FetchRoute): () => void
}

/** The Host `connection` service, as far as this plugin needs it. */
interface ConnectionService {
  /** The exact Fetch-route registry; absent when no browser carrier is mounted. */
  fetch?: ConnectionFetchRegistry
}

/**
 * Build one failure answer.
 * @param code - stable machine-readable code.
 * @param message - human-readable message.
 * @param details - extra structured detail.
 * @returns the failure in the envelope shape.
 */
function fail(code: string, message: string, details: Record<string, unknown> = {}): RpcResult<SystemProxyReading> {
  const error: RpcFailure = { code, message, details }
  return { ok: false, error }
}

/**
 * Wrap one result in the response envelope Connection's browser caller parses.
 * @param rpcId - the request's correlation id.
 * @param result - the endpoint's answer.
 * @returns the JSON response.
 */
function respond(rpcId: string, result: RpcResult<SystemProxyReading>): Response {
  return Response.json({ type: 'server-response', rpcId, result })
}

/**
 * Answer one call to this plugin's endpoint.
 * @param request - the buffered request Connection hands over.
 * @returns the response envelope.
 */
async function answer(request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return respond(INVALID_RPC_ID, fail('dsh-proxy/bad-request', 'the request body is not JSON'))
  }
  const envelope = (typeof body === 'object' && body !== null ? body : {}) as Partial<ClientRequestEnvelope>
  const rpcId = typeof envelope.rpcId === 'string' ? envelope.rpcId : INVALID_RPC_ID
  if (envelope.type !== 'client-request' || envelope.method !== SYSTEM_PROXY_ENDPOINT) {
    return respond(rpcId, fail(
      'dsh-proxy/unknown-endpoint',
      `dsh-proxy answers only "${SYSTEM_PROXY_ENDPOINT}" on this route`,
      { method: typeof envelope.method === 'string' ? envelope.method : null },
    ))
  }
  try {
    return respond(rpcId, { ok: true, value: readSystemProxy() })
  } catch (cause) {
    return respond(rpcId, fail(
      'dsh-proxy/system-proxy-failed',
      cause instanceof Error ? cause.message : String(cause),
    ))
  }
}

/**
 * Serve {@link SYSTEM_PROXY_ROUTE} on Connection's browser carrier.
 *
 * The registration follows the `connection` service: it is installed when the
 * service appears and withdrawn with this plugin's fiber.
 * @param ctx - the Host plugin context to hang the route under.
 */
export function installSystemProxyRpc(ctx: Context): void {
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.get('connection') as ConnectionService | undefined
    const routes = connection?.fetch
    if (routes === undefined) return
    let dispose: (() => void) | undefined
    try {
      dispose = routes.register({
        path: SYSTEM_PROXY_ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: answer,
      })
    } catch (cause) {
      connectionCtx.logger.warn(
        'dsh-proxy: cannot serve %s (%s); the settings page will not be able to read the system proxy',
        SYSTEM_PROXY_ROUTE,
        cause instanceof Error ? cause.message : String(cause),
      )
      return
    }
    connectionCtx.effect(() => () => { dispose?.() })
  })
}
