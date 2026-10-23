/**
 * Phase timing for a request that never produced response headers.
 *
 * Why this exists: the attempt record says *that* a probe timed out and how long
 * it waited, but not **where** the time went — a CONNECT the proxy never
 * answered, a TLS handshake inside the tunnel, or response headers that never
 * arrived. That distinction is the whole diagnosis: on this machine the tunnel
 * opened in 1-14 ms while the same attempt still missed a one-second budget, so
 * the ceiling was cutting off a working tunnel instead of detecting a dead one,
 * and nothing in the log could say so.
 *
 * The numbers come from undici's own diagnostics channels rather than from a
 * wrapper, because a wrapper measures the caller's wait and not the phases it
 * consists of:
 *   - 'undici:client:connected' for the target host is the moment the socket (or
 *     the CONNECT tunnel) is up: `connectMs`.
 *   - 'undici:request:headers' for the same **request object** is the moment the
 *     response arrived: `headersMs`. A probe times out when this never fires.
 *     The request object is what `undici:request:create` hands out, and binding
 *     to it is not decoration: origin alone is shared by every concurrent request
 *     to that host, and a tracker that took another request's headers reported a
 *     probe as answered in 1 274 ms while the attempt itself timed out at
 *     3 005 ms. One object, one answer.
 *   - 'undici:client:connectError' carries the transport code when the dial
 *     itself failed, which separates "could not reach" from "did not answer".
 *
 * Off unless something asks for a tracker, so the request path pays nothing when
 * no probe is running. One tracker is one attempt; `finish` reads it and any
 * later event is ignored.
 * @module dsh-proxy/timeline
 */

import { channel as diagnosticsChannel } from 'node:diagnostics_channel'

/** One attempt's phase breakdown, in milliseconds from the attempt's start. */
export interface ProbeTimeline {
  /** Milliseconds until the socket to the target (or the CONNECT tunnel) was up. */
  connectMs?: number
  /** Milliseconds until response headers arrived; absent when they never did. */
  headersMs?: number
  /** Transport code of a connect failure, when the dial itself failed. */
  connectError?: string
}

/** One open measurement. */
export interface ProbeTracker {
  /**
   * Read what happened so far.
   * @returns the phases that were observed.
   */
  finish(): ProbeTimeline
  /** Stop observing this attempt. Safe to call more than once. */
  dispose(): void
}

/** The payload shapes this module reads; undici owns the real types. */
interface ConnectParamsLike { hostname?: unknown }
interface CreatePayloadLike { request?: { origin?: unknown } }
interface ConnectErrorPayloadLike { connectParams?: ConnectParamsLike; error?: { code?: unknown } }
interface ConnectedPayloadLike { connectParams?: ConnectParamsLike }

/** One tracked attempt. */
interface Entry {
  origin: string
  hostname: string
  startedAt: number
  timeline: ProbeTimeline
  active: boolean
  /**
   * The undici request this attempt opened, once `request:create` named it.
   *
   * Headers are matched on this identity rather than on the origin: a busy host
   * has several requests on one origin at a time, and borrowing a neighbour's
   * headers makes a timed-out probe look answered.
   */
  request?: object
}

/** Every live tracker; empty means the channels are not subscribed. */
const live = new Set<Entry>()

/** The unsubscribe callbacks of the installed listeners. */
let unsubscribers: Array<() => void> = []

/** Origin of a diagnostics `request` payload. */
function originOf(payload: unknown): string {
  const request = (payload as CreatePayloadLike | undefined)?.request
  return typeof request?.origin === 'string' ? request.origin : ''
}

/** Hostname of a diagnostics `connectParams` payload. */
function hostnameOfConnect(payload: unknown): string {
  const host = (payload as ConnectedPayloadLike | undefined)?.connectParams?.hostname
  return typeof host === 'string' ? host : ''
}

/** Trackers matching one hostname, still active. */
function forHostname(hostname: string): Entry[] {
  const matched: Entry[] = []
  for (const entry of live) if (entry.active && entry.hostname === hostname) matched.push(entry)
  return matched
}

/** Trackers matching one origin, still active, oldest first. */
function forOrigin(origin: string): Entry[] {
  const matched: Entry[] = []
  for (const entry of live) if (entry.active && entry.origin === origin) matched.push(entry)
  return matched.sort((left, right) => left.startedAt - right.startedAt)
}

/** Install the diagnostics listeners once, while at least one tracker is live. */
function subscribe(): void {
  if (unsubscribers.length > 0) return
  const now = (): number => performance.now()
  const listen = (name: string, handler: (payload: unknown) => void): void => {
    const channel = diagnosticsChannel(name)
    const listener = (payload: unknown): void => { handler(payload) }
    channel.subscribe(listener)
    unsubscribers.push(() => { channel.unsubscribe(listener) })
  }
  listen('undici:client:connected', (payload) => {
    const hostname = hostnameOfConnect(payload)
    if (hostname.length === 0) return
    const at = now()
    for (const entry of forHostname(hostname)) {
      if (entry.timeline.connectMs === undefined) entry.timeline.connectMs = Math.round(at - entry.startedAt)
    }
  })
  listen('undici:client:connectError', (payload) => {
    const hostname = hostnameOfConnect(payload)
    if (hostname.length === 0) return
    const code = (payload as ConnectErrorPayloadLike | undefined)?.error?.code
    if (typeof code !== 'string') return
    for (const entry of forHostname(hostname)) {
      if (entry.timeline.connectError === undefined) entry.timeline.connectError = code
    }
  })
  // The request object is the correlation key: `request:create` and
  // `request:headers` publish the very same instance, so an answer can only ever
  // be attributed to the attempt that asked for it. The oldest unbound tracker
  // on that origin takes it, which is the order the fetches were issued in.
  listen('undici:request:create', (payload) => {
    const request = (payload as CreatePayloadLike | undefined)?.request
    const origin = originOf(payload)
    if (origin.length === 0 || request === undefined || request === null) return
    for (const entry of forOrigin(origin)) {
      if (entry.request === undefined) {
        entry.request = request
        return
      }
    }
  })
  listen('undici:request:headers', (payload) => {
    const request = (payload as CreatePayloadLike | undefined)?.request
    if (request === undefined || request === null) return
    const at = now()
    for (const entry of live) {
      if (entry.active && entry.request === request && entry.timeline.headersMs === undefined) {
        entry.timeline.headersMs = Math.round(at - entry.startedAt)
        return
      }
    }
  })
}

/** Drop the listeners once the last tracker is gone. */
function unsubscribeIfIdle(): void {
  if (live.size > 0) return
  for (const off of unsubscribers.splice(0)) {
    try { off() } catch { /* a channel already gone is not an error here */ }
  }
}

/**
 * Start measuring one attempt.
 *
 * `origin` is the absolute request origin ('scheme://host'); `hostname` is the
 * host whose socket marks the connection as up — for a proxied attempt that is
 * still the target host, because the tunnel's own dial to the proxy is reported
 * as a separate connection with the proxy's own hostname.
 * @param origin - the request's origin, in the form undici reports it.
 * @param hostname - the target hostname.
 * @returns the tracker; `dispose` it when the attempt ends.
 */
export function openProbeTracker(origin: string, hostname: string): ProbeTracker {
  const entry: Entry = {
    origin,
    hostname,
    startedAt: performance.now(),
    timeline: {},
    active: true,
  }
  live.add(entry)
  subscribe()
  return {
    finish: () => {
      entry.active = false
      return { ...entry.timeline }
    },
    dispose: () => {
      entry.active = false
      live.delete(entry)
      unsubscribeIfIdle()
    },
  }
}

/** Render one timeline for a log line; empty string when nothing was observed. */
export function describeTimeline(timeline: ProbeTimeline): string {
  const parts: string[] = []
  if (timeline.connectMs !== undefined) parts.push('connect=' + String(timeline.connectMs) + 'ms')
  if (timeline.headersMs !== undefined) parts.push('headers=' + String(timeline.headersMs) + 'ms')
  if (timeline.connectError !== undefined) parts.push('connect-error=' + timeline.connectError)
  return parts.join(' ')
}
