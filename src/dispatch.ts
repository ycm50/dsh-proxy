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

import { Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { hostnameOf } from './hosts.js'
import { isExemptHostname } from './proxy.js'
import { transportCodeOf } from './retry.js'
import type { DispatchRecord, RouteChannel } from './routing.js'

export { isExemptHostname }

/** One channel pair plus the per-hostname choice between them. */
export interface RoutingInput {
  /** Channel for every request the choice does not send through the proxy. */
  direct: Dispatcher
  /** Channel for hosts the configuration names. */
  proxied: Dispatcher
  /** Whether one hostname travels through the proxy (exemptions already applied). */
  proxyFor(hostname: string): boolean
  /**
   * Whether this hostname's channel may move at all.
   *
   * A pinned host is always proxied and a loopback/LAN name is always direct, so
   * neither has a cursor to move; only the hosts in between are observed.
   */
  rotateFor?(hostname: string): boolean
  /**
   * Where each dispatched request's outcome is reported.
   *
   * The dispatcher is the layer that serves callers which captured `fetch`
   * before this plugin mounted, so it has to move the same cursor the wrapped
   * path moves — otherwise those callers retry on one channel forever.
   */
  onOutcome?(record: DispatchRecord): void
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
export class RoutingDispatcher extends Dispatcher {
  constructor(private readonly input: RoutingInput) {
    super()
  }

  /** @inheritdoc */
  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    let target = this.input.direct
    let channel: RouteChannel = 'direct'
    let hostname = ''
    const origin = options?.origin
    if (origin !== undefined && origin !== null) {
      try {
        hostname = hostnameOf(origin as string | URL)
      } catch {
        hostname = ''
      }
    }
    if (hostname.length > 0 && !isExemptHostname(hostname) && this.input.proxyFor(hostname)) {
      target = this.input.proxied
      channel = 'proxy'
    }
    const onOutcome = this.input.onOutcome
    // Only a host that may move is observed: watching a pinned or loopback host
    // would cost a handler wrapper for an answer nothing can act on.
    const observe = onOutcome !== undefined
      && hostname.length > 0
      && (this.input.rotateFor?.(hostname) ?? false)
    if (!observe) return target.dispatch(options, handler)
    const startedAt = performance.now()
    let settled = false
    const settle = (ok: boolean, code?: string): void => {
      if (settled) return
      settled = true
      onOutcome({
        hostname,
        channel,
        ok,
        ms: Math.round(performance.now() - startedAt),
        ...(code === undefined ? {} : { code }),
      })
    }
    // Field-for-field forwarding with one addition: the two callbacks that say
    // how the attempt ended also move the host's cursor.
    const observed: Dispatcher.DispatchHandler = {
      onConnect: (abort) => { handler.onConnect?.(abort) },
      onHeaders: (statusCode, rawHeaders, resume, statusText) => {
        settle(true)
        return handler.onHeaders?.(statusCode, rawHeaders, resume, statusText) ?? false
      },
      onData: (chunk) => handler.onData?.(chunk) ?? false,
      onComplete: (trailers) => { handler.onComplete?.(trailers) },
      onError: (error) => {
        settle(false, transportCodeOf(error))
        handler.onError?.(error)
      },
      onUpgrade: (statusCode, rawHeaders, socket) => {
        settle(true)
        handler.onUpgrade?.(statusCode, rawHeaders, socket)
      },
    }
    return target.dispatch(options, observed)
  }

  /** Close both channels, waiting for in-flight requests. */
  override close(callback: () => void): void
  override close(): Promise<void>
  override close(callback?: () => void): void | Promise<void> {
    const done: Promise<void> = Promise.all([
      this.input.direct.close(),
      this.input.proxied.close(),
    ]).then(() => undefined)
    if (callback === undefined) return done
    void done.then(
      () => callback(),
      () => callback(),
    )
    return undefined
  }

  /** Destroy both channels immediately, dropping in-flight requests. */
  override destroy(err: Error | null, callback: () => void): void
  override destroy(callback: () => void): void
  override destroy(err: Error | null): Promise<void>
  override destroy(): Promise<void>
  override destroy(err?: Error | null | (() => void), callback?: () => void): void | Promise<void> {
    const error = typeof err === 'function' ? null : err ?? null
    const done = typeof err === 'function' ? err : callback
    for (const channel of [this.input.direct, this.input.proxied]) {
      try {
        void channel.destroy(error)
      } catch {
        /* a channel that is already gone is not a failure */
      }
    }
    if (done !== undefined) {
      done()
      return undefined
    }
    return Promise.resolve()
  }
}

/**
 * Live global-dispatcher installs, oldest first.
 *
 * Kept as a stack for the same reason the fetch wrapper is: every instance
 * captures the fetch/dispatcher it saw when it mounted, so one instance's
 * teardown must hand the global back to another *live* instance — never to its
 * own dead predecessor.
 */
const liveDispatchers: Array<{ token: symbol; dispatcher: Dispatcher }> = []

/** The dispatcher in place before this module's first install. */
let baseDispatcher: Dispatcher | undefined

/** Whether a dispatcher is one this module installed. */
function isLiveDispatcher(candidate: Dispatcher | undefined): boolean {
  return candidate !== undefined && liveDispatchers.some(entry => entry.dispatcher === candidate)
}

/**
 * Publish a routing dispatcher as the process-wide one.
 * @param token - the installing instance's handle, for uninstallGlobalDispatcher.
 * @param dispatcher - the routing dispatcher to install.
 */
export function installGlobalDispatcher(token: symbol, dispatcher: Dispatcher): void {
  if (liveDispatchers.length === 0) baseDispatcher = getGlobalDispatcher()
  liveDispatchers.push({ token, dispatcher })
  setGlobalDispatcher(dispatcher)
}

/**
 * Retire one install, re-pointing the global at the newest live one — or back
 * at the dispatcher that preceded them all when none is left.
 *
 * The global is only touched while it is still one of ours: another plugin may
 * have replaced it since, and that replacement is not this module's to undo.
 * @param token - the handle installGlobalDispatcher was called with.
 * @returns whether the install was still held.
 */
export function uninstallGlobalDispatcher(token: symbol): boolean {
  const index = liveDispatchers.findIndex(entry => entry.token === token)
  if (index === -1) return false
  const removed = liveDispatchers[index]
  liveDispatchers.splice(index, 1)
  const current = getGlobalDispatcher()
  // Someone else took the slot after us: leave it alone.
  if (removed !== undefined && current !== removed.dispatcher && !isLiveDispatcher(current)) return true
  const newest = liveDispatchers[liveDispatchers.length - 1]
  if (newest !== undefined) {
    setGlobalDispatcher(newest.dispatcher)
    return true
  }
  const base = baseDispatcher
  baseDispatcher = undefined
  if (base !== undefined) setGlobalDispatcher(base)
  return true
}

/** How many installs this module currently holds (tests reach for it). */
export function liveDispatcherCount(): number {
  return liveDispatchers.length
}
