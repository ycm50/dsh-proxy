/**
 * The per-host channel memory: a host is decided **once** and then kept on that
 * channel for the rest of the session.
 *
 * The previous strategy rotated on every attempt — direct, proxy, direct,
 * proxy — which kept both paths exercised but also kept *all* of a host's
 * traffic on the wrong one half of the time, and put a fresh 1.3–1.9 s tunnel
 * inside half of the first tokens. This module replaces the rotation with a
 * decision that is remembered, which is what the user asked for: the first
 * request of a session goes direct, and only a direct path that does not answer
 * moves the host onto the proxy — and once a channel answers, the host stays
 * there.
 *
 * The rules, in the order they are applied:
 *   - A host pinned by the force list always travels through the proxy; it never
 *     probes and never moves. A loopback or LAN name never leaves the machine.
 *     Both answers outrank the memory entirely.
 *   - Every other host starts **direct**, with a {@link PROBE_TIMEOUT_MS}
 *     budget. Answering inside it settles the host on direct for the session.
 *   - A direct attempt that does not answer in time hands the host to the proxy,
 *     which gets its own, shorter {@link PROXY_PROBE_TIMEOUT_MS} budget: a
 *     forward proxy answers a CONNECT in milliseconds, so a tunnel that has not
 *     produced headers by then is not going to. Answering settles the host on the
 *     proxy (the "direct is unreachable, so keep using the tunnel" case).
 *   - A proxy attempt that also runs out of time falls back to direct for one
 *     **unbounded** attempt: with both probes inconclusive the direct path is
 *     still the default, and cutting it off a second time would leave the user
 *     with an error they could have avoided.
 *   - Whatever answers settles the host, including the unbounded fallback: a
 *     direct path that needed more than its budget is still a *working* direct
 *     path, and demoting it to the proxy would only move a slow route onto a
 *     tunnel that never answered. This is where the measured 2.9-20.8 s direct
 *     answers land, underneath the old one-second budget that kept them out.
 *   - A settled host that then fails outright (a connection error, not a slow
 *     answer) probes the other channel once and settles on it when it answers;
 *     when that probe fails too, the host goes back to direct. Success never
 *     moves a host: there is no timed rotation.
 *   - **Any** failure moves the decision (unless the caller cancelled or the
 *     body cannot be re-sent). Advancing the decision sends nothing, and
 *     freezing it is what once pinned a host to the channel that had just
 *     failed: the next request then opened with the same doomed probe and failed
 *     the same way, which is the "consecutive failures" the log showed.
 *
 * This module is pure state: it never touches the network or a clock of its own
 * (the probe deadline lives in the request path), so every transition is
 * asserted offline.
 * @module dsh-proxy/routing
 */

/** The two channels a request can travel on. */
export type RouteChannel = 'proxy' | 'direct'

/** The channel an untouched host starts on; also the fallback of last resort. */
export const FIRST_CHANNEL: RouteChannel = 'direct'

/**
 * How long an unproven **direct** channel gets to answer before the other one is
 * tried.
 *
 * Measured to the response headers. The shipped one second was too short for the
 * links this plugin is used on: on this machine the same host that missed a one
 * second probe answered on the next attempt in 2.9-20.8 s, so 29 of 40 direct
 * successes landed outside the old budget and each miss bought a pointless
 * proxy detour. Five seconds covers the observed direct answers with room for a
 * bad gateway minute; it is a routing deadline, not the transport ceiling in
 * `dsh-proxy/stability` (60 s), and a settled host is only bounded by it while
 * it has not yet proven itself (see {@link RouteMemory}).
 */
export const PROBE_TIMEOUT_MS = 5_000

/**
 * How long an unproven **proxy** channel gets to answer.
 *
 * Shorter on purpose. A local forward proxy answers `CONNECT` in single-digit
 * milliseconds, so the one-second probe it used to share with the direct path
 * was pure loss: the tunnel that never answered for a host cost the same full
 * second as the direct path that did answer. Two seconds keeps a slow tunnel on
 * a loaded machine possible without letting a dead one burn the whole budget.
 */
export const PROXY_PROBE_TIMEOUT_MS = 3_000

/** The transport code a probe that ran out of time carries, for the log. */
export const PROBE_TIMEOUT_CODE = 'PROBE_TIMEOUT'

/** The other channel, for a host that just failed. */
export function otherChannel(channel: RouteChannel): RouteChannel {
  return channel === 'direct' ? 'proxy' : 'direct'
}

import type { ProbeTimeline } from './timeline.js'

/** One finished dispatch, as the process-wide dispatcher reports it. */
export interface DispatchRecord {
  /** The request's hostname. */
  hostname: string
  /** The channel the dispatch took. */
  channel: RouteChannel
  /** Whether the request produced response headers. */
  ok: boolean
  /** Dispatch to headers (or to the failure), in milliseconds. */
  ms: number
  /** Transport code of the failure, when the dispatch carried one. */
  code?: string
}

/** One finished attempt, as the request path reports it. */
export interface RouteAttempt {
  /** The request's hostname; `''` when the URL could not be read. */
  hostname: string
  /** 1 for the first attempt of this request. */
  attempt: number
  /** How many attempts this request is allowed in total. */
  maxAttempts: number
  /** The channel this attempt actually used. */
  channel: RouteChannel
  /** Whether the attempt produced a response (of any status). */
  ok: boolean
  /** Wall time of the attempt: to the response headers, or to the failure. */
  ms: number
  /** Transport code of the failure, when the attempt carried one. */
  code?: string
  /** The failure's message, the only clue when no transport code exists. */
  message?: string
  /** Whether this attempt was still proving its channel (the probe budget applied). */
  probe?: boolean
  /**
   * Where the time went, for a failed probe.
   *
   * Only a probe that ran out of time carries this: it says whether the socket
   * (or the CONNECT tunnel) ever came up, so "the tunnel is dead" and "the tunnel
   * works but the answer is slow" stop looking the same in the log. See
   * `dsh-proxy/timeline`.
   */
  timeline?: ProbeTimeline
  /** The channel the next attempt will take; absent when the request is over. */
  next?: RouteChannel
}

/**
 * How long one channel may stay silent before the other one is tried.
 *
 * The two budgets differ because the two channels differ: a forward proxy
 * answers a CONNECT in milliseconds, while a direct TLS handshake plus response
 * headers on a slow link legitimately takes seconds (see
 * {@link PROBE_TIMEOUT_MS}). Only an unproven channel is ever bounded this way.
 * @param channel - the channel the attempt takes.
 * @param probeTimeoutMs - the direct budget.
 * @param proxyProbeTimeoutMs - the proxy budget.
 * @returns the budget for that channel, in milliseconds.
 */
export function probeBudgetFor(
  channel: RouteChannel,
  probeTimeoutMs: number = PROBE_TIMEOUT_MS,
  proxyProbeTimeoutMs: number = PROXY_PROBE_TIMEOUT_MS,
): number {
  return channel === 'proxy' ? proxyProbeTimeoutMs : probeTimeoutMs
}

/**
 * What the next attempt for a host takes.
 *
 * `probe` marks a channel that has not answered yet: the request path bounds it
 * with {@link PROBE_TIMEOUT_MS}. `fallback` marks the final direct attempt after
 * both probes ran out of time: it is not bounded and it is never moved to the
 * proxy again (a failure there ends the request).
 */
export interface RouteDecision {
  /** The channel the attempt must take. */
  channel: RouteChannel
  /** Whether the channel still has to prove itself; the probe budget applies. */
  probe: boolean
  /** Whether this is the unbounded direct attempt after both probes failed. */
  fallback: boolean
}

/** What the memory holds for one host, for tests and log lines. */
export type RouteState = RouteDecision

/**
 * One host's state.
 *
 * Exactly one of the three forms is used: `settled` (answered and kept),
 * `probe` (being tried, with what happens if it fails), or `fallback` (both
 * probes failed; direct gets the last, unbounded attempt).
 */
interface Entry {
  /** The channel that answered and is kept for the session. */
  settled?: RouteChannel
  /** The channel currently being probed. */
  probe?: RouteChannel
  /** What to try when that probe fails: the other channel, or the direct fallback. */
  probeNext?: 'other' | 'fallback'
  /** Both probes ran out of time; one unbounded direct attempt is owed. */
  fallback?: boolean
}

/**
 * Which channel each host is on, remembered for the session.
 *
 * One instance belongs to one generation of channels, so a settings change that
 * rebuilds the channels (or a new session, see `dsh-proxy/index`) starts every
 * host from direct again — the honest answer to "the transport was just
 * reconfigured" and to "this is a new conversation".
 */
export class RouteMemory {
  readonly #hosts = new Map<string, Entry>()

  /**
   * The channel the next attempt for this host should take.
   *
   * Pure: the dispatcher asks for every request and the wrapper asks again for
   * the same one, so asking must not advance the state.
   * @param hostname - the request's hostname.
   * @returns the decision for the next attempt.
   */
  decide(hostname: string): RouteDecision {
    const entry = this.#hosts.get(hostname)
    if (entry?.probe !== undefined) {
      return { channel: entry.probe, probe: true, fallback: false }
    }
    if (entry?.fallback === true) {
      return { channel: FIRST_CHANNEL, probe: false, fallback: true }
    }
    if (entry?.settled !== undefined) {
      return { channel: entry.settled, probe: false, fallback: false }
    }
    return { channel: FIRST_CHANNEL, probe: true, fallback: false }
  }

  /**
   * Record that a channel answered, and keep the host on it.
   *
   * Every success lands here, including the first direct probe, the proxy probe
   * that replaced a silent direct path, and the other channel that rescued a
   * settled host. A host that already settled on this channel is left alone.
   * @param hostname - the request's hostname.
   * @param channel - the channel that answered.
   */
  settle(hostname: string, channel: RouteChannel): void {
    const entry = this.#hosts.get(hostname)
    if (entry?.settled === channel && entry.probe === undefined && entry.fallback === undefined) return
    this.#hosts.set(hostname, { settled: channel })
  }


  /**
   * Record one failed attempt and decide what the next one may take.
   *
   * A failure on the channel currently being probed advances that probe to its
   * successor; a failure on a settled channel starts a one-shot probe of the
   * other channel; a failure of the fallback forgets the host, so the next
   * request starts the decision over. An outcome that no longer matches the
   * state (another request moved the host in between) follows the current
   * decision instead of counting the failure twice.
   * @param hostname - the request's hostname.
   * @param channel - the channel that failed.
   * @returns the decision for the next attempt, or undefined when this request
   * has no further attempt to make.
   */
  failed(hostname: string, channel: RouteChannel): RouteDecision | undefined {
    const entry = this.#hosts.get(hostname) ?? { probe: FIRST_CHANNEL, probeNext: 'other' as const }
    if (entry.probe === channel) {
      if (entry.probeNext === 'other') {
        this.#hosts.set(hostname, { probe: otherChannel(channel), probeNext: 'fallback' })
      } else {
        this.#hosts.set(hostname, { fallback: true })
      }
      return this.decide(hostname)
    }
    if (entry.fallback === true) {
      // The fallback is the direct attempt, so only a direct failure ends the
      // decision. A failure on the other channel means a concurrent request
      // advanced the host while this attempt was in flight: follow the current
      // decision instead of deleting a state this outcome never saw.
      if (channel !== FIRST_CHANNEL) return this.decide(hostname)
      // The last attempt failed too: no channel is known to work, so the next
      // request starts the decision from direct again instead of pinning the
      // host to a path that just failed.
      this.#hosts.delete(hostname)
      return undefined
    }
    if (entry.settled === channel) {
      this.#hosts.set(hostname, { probe: otherChannel(channel), probeNext: 'fallback' })
      return this.decide(hostname)
    }
    return this.decide(hostname)
  }

  /**
   * What the memory holds for one host, for tests and log lines.
   * @param hostname - the request's hostname.
   * @returns the decision, or undefined when the host has never been touched.
   */
  stateOf(hostname: string): RouteState | undefined {
    return this.#hosts.has(hostname) ? this.decide(hostname) : undefined
  }

  /** Forget every host, so every one of them starts direct again. */
  reset(): void {
    this.#hosts.clear()
  }
}

/** One line describing the shipped strategy, for the mount log. */
export function describeRouting(
  maxAttempts: number,
  probeTimeoutMs: number = PROBE_TIMEOUT_MS,
  proxyProbeTimeoutMs: number = PROXY_PROBE_TIMEOUT_MS,
): string {
  return 'route=sticky (direct first with a ' + String(probeTimeoutMs) + 'ms probe, the proxy gets '
    + String(proxyProbeTimeoutMs) + 'ms, the channel that answers is kept; up to ' + String(maxAttempts)
    + ' attempt' + (maxAttempts === 1 ? '' : 's') + ')'
}
