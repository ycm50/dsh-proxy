/**
 * Proxy transport and host-routing helpers for `dsh-proxy`.
 *
 * The plugin does not touch DeepSeek Harness source. It installs a wrapper
 * around `globalThis.fetch` — which both the DeepSeek adapter's raw `fetch` and
 * the pi-ai SDK clients call — and decides, per host, whether a request takes the
 * proxy or this plugin's own **hardened direct** channel. Hosts on the force list
 * always take the proxy; every other host starts direct and only moves onto the
 * proxy when direct does not answer in time or fails outright (see
 * {@link RouteMemory}). Loopback and private networks are exempt throughout (see
 * {@link isExemptHostname}).
 *
 * Both channels are built from the same hardened options (see
 * `dsh-proxy/stability`): a long connect ceiling, TCP keepalive, a bounded
 * pooled-idle window, and a transport-level retry for connection failures. The
 * point of hardening the direct channel too is that "not proxied" must not mean
 * "back to undici's 10 second connect timeout" — the failing requests measured
 * on this machine were direct connects.
 * @module dsh-proxy/proxy
 */

import { Agent, Dispatcher, ProxyAgent, Request as UndiciRequest, fetch as undiciFetch } from 'undici'
import { hostnameOf, isLanHostname, matchesHostEntry } from './hosts.js'
import { agentOptionsOf, connectorOptionsOf } from './stability.js'
import type { HardenedAgentOptions, StabilityConfig } from './stability.js'
import {
  abortableSleep,
  isAborted,
  isReplayableRequest,
  isRetryableTransportError,
  retryDelayMs,
  transportCodeOf,
  withTransportRetry,
} from './retry.js'
import type { RetryAttempt } from './retry.js'
import type { ProxyObserver } from './observe.js'
import { PROBE_TIMEOUT_CODE, PROBE_TIMEOUT_MS } from './routing.js'
import type { RouteAttempt, RouteChannel, RouteDecision, RouteMemory } from './routing.js'

export {
  DEFAULT_DEEPSEEK_HOST,
  DEFAULT_MODEL_HOST_SUFFIXES,
  DEFAULT_MODEL_HOSTS,
  hostnameOf,
  isLanHostname,
  matchesHostEntry,
  normalizeHostEntry,
} from './hosts.js'

/** Extract the absolute URL string from a `fetch` input. */
export function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/** One IPv4 octet, so a loopback match cannot accept `127.999.1.1`. */
const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'

/**
 * The whole `127.0.0.0/8` block, not just its first address: judging only
 * `127.0.0.1` misses `127.0.0.2`, which binds to loopback just as surely.
 */
const LOOPBACK_IPV4 = new RegExp('^127\\.' + IPV4_OCTET + '\\.' + IPV4_OCTET + '\\.' + IPV4_OCTET + '$')

/**
 * Whether a hostname names this machine, and therefore must stay direct.
 *
 * **This guarantee is this plugin's own; the routing this was built on had
 * none.** The baseline decides purely on `proxyHosts` / `excludeHosts`, which
 * is harmless while only a handful of model-API domains are routed, but the
 * harness's own Web UI, its Connection transport, and every local test server
 * listen on loopback, so a user who writes a loopback endpoint into
 * `proxyHosts` would send the harness's own traffic back through the proxy
 * and close a loop on it. Loopback is therefore exempt unconditionally.
 *
 * The test is deliberately **pure string comparison — never DNS**. A lookup
 * here would block, could disagree with what the socket actually resolves,
 * and would make a routing decision depend on the network being up.
 *
 * Callers pass `new URL(...).hostname`, which for IPv6 yields the bracketed
 * form, so `[::1]` and `[::ffff:127.0.0.1]` are handled alongside the bare
 * spellings; a trailing dot (the FQDN spelling `localhost.`) is stripped for
 * the same reason `normalizeHostEntry` strips it.
 * @param hostname - a URL hostname, bracketed or not, in any case.
 * @returns whether the host is loopback or an unspecified address.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true
  // The IPv4-mapped spelling: `::ffff:127.0.0.1` may arrive fully expanded
  // as `::ffff:7f00:1`, so read the high group and keep it when 127/8.
  const mappedHigh = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(host)?.[1]
  if (mappedHigh !== undefined) return Number.parseInt(mappedHigh, 16) >>> 8 === 127
  return LOOPBACK_IPV4.test(host.startsWith('::ffff:') ? host.slice(7) : host)
}

/**
 * Whether a hostname must never travel through a proxy at all.
 *
 * Two builds of the same rule, and both are this plugin's own guarantee rather
 * than a configurable one: loopback carries the harness's own surfaces (a
 * proxied Web UI request would loop back onto the proxy), and private networks
 * carry local model servers, MCP endpoints, and routers (a proxied LAN request
 * either fails or leaves the building). Listing such a host in
 * `proxyHosts` therefore cannot route it; `excludeHosts` is judged later
 * and only ever agrees.
 * @param hostname - a URL hostname, bracketed or not, in any case.
 * @returns whether the host is exempt from proxying.
 */
export function isExemptHostname(hostname: string): boolean {
  return isLoopbackHostname(hostname) || isLanHostname(hostname)
}

/**
 * Whether a hostname is pinned to the proxy by the force list.
 *
 * The force list is the one list there is: a host named there always travels
 * through the proxy, and it is the answer for a site that *can* be reached
 * directly but is throttled hard enough that trying is pointless — a mirror that
 * answers in 30 s direct and in 2 s through the proxy. A pinned host never
 * probes and never moves (see `dsh-proxy/routing`): there is no direct attempt to
 * compare against.
 *
 * The built-in exemption still outranks it: loopback and private networks never
 * travel at all, whatever the list says.
 * @param hostname - the request hostname.
 * @param force - normalized entries pinned to the proxy.
 * @returns whether the request must travel through the proxy.
 */
export function shouldForceProxy(
  hostname: string,
  force: ReadonlySet<string>,
): boolean {
  if (isExemptHostname(hostname)) return false
  for (const entry of force) {
    if (matchesHostEntry(hostname, entry)) return true
  }
  return false
}

/** A proxy dispatcher plus a `fetch` bound to it, for teardown. */
export interface ProxyFetch {  /** Fetch that routes every request through the proxy. */
  fetch: typeof fetch
  /** Close the proxy dispatcher's idle connections. */
  close(): Promise<void>
}

/** One hardened channel: its fetch, its dispatcher, and how to retire it. */
export interface HardenedChannel extends ProxyFetch {
  /** The dispatcher itself, so it can be re-exported to callers that need one. */
  dispatcher: Dispatcher
  /** Whether this channel actually travels through a proxy. */
  proxied: boolean
  /**
   * The same channel without its transport retry.
   *
   * The routing layer needs a failure to arrive at its own decision point
   * immediately: in auto mode the retry that matters is "try the other
   * channel", and four internal re-dials of a path that just failed only delay
   * it. Unlisted hosts keep using {@link ProxyFetch.fetch}, so the transport
   * retry is still there wherever it is the only retry available.
   */
  fetchOnce: typeof fetch
}

/** Build parameters shared by both channels. */
export interface ChannelOptions {
  /** Effective stability settings (timeouts, keepalive, retry budget). */
  stability: StabilityConfig
  /** Called once per transport retry, for the host half's log line. */
  onRetry?: (attempt: RetryAttempt) => void
  /** Opt-in request timing; absent means the channel measures nothing. */
  observer?: ProxyObserver
}

/**
 * The construction options of the proxy dispatcher.
 *
 * `proxyTls` and `requestTls` are not decoration: `undici`'s `ProxyAgent` builds
 * both of its connectors from exactly those two objects — `proxyTls` for the
 * dial to the proxy, `requestTls` for the TLS handshake to the target inside
 * the tunnel — and ignores the top-level `connect` object entirely (it is
 * overwritten by the tunnel dialer). Passing
 * {@link connectorOptionsOf} as both is therefore the only way the configured
 * connect ceiling reaches a `CONNECT` tunnel; without it the tunnel kept
 * undici's 10 s default, which is what turned a measured 10.5 s handshake into
 * `UND_ERR_CONNECT_TIMEOUT`.
 * @param proxyUrl - the proxy endpoint.
 * @param stability - the effective settings.
 * @param agentOptions - the shared agent options (pool, timeouts, keepalive).
 * @returns the argument for `new ProxyAgent(...)`.
 */
function proxyAgentOptions(
  proxyUrl: string,
  stability: StabilityConfig,
  agentOptions: HardenedAgentOptions,
): ConstructorParameters<typeof ProxyAgent>[0] {
  const connector = connectorOptionsOf(stability)
  return {
    uri: proxyUrl,
    ...agentOptions,
    // The two hops the tunnel consists of, each built from its own object.
    proxyTls: connector,
    requestTls: connector,
  } as unknown as ConstructorParameters<typeof ProxyAgent>[0]
}

/** Header pairs, from anything fetch accepts as a header list. */
export function headerPairs(headers: unknown): Array<[string, string]> | undefined {
  if (headers === undefined || headers === null) return undefined
  if (Array.isArray(headers)) {
    return headers.map((entry) => {
      const [name, value] = entry as [unknown, unknown]
      return [String(name), String(value)] as [string, string]
    })
  }
  if (typeof (headers as Iterable<unknown>)[Symbol.iterator] === 'function') {
    return [...(headers as Iterable<[unknown, unknown]>)].map(([name, value]) => [String(name), String(value)])
  }
  return Object.entries(headers as Record<string, unknown>).map(([name, value]) => [name, String(value)])
}

/** One fetch call, in the shape this plugin's own undici can read. */
export interface NormalisedCall {
  /** The URL string, or an input the bundled undici already recognises. */
  input: string | URL | Request
  /** The init to pass beside it. */
  init: RequestInit | undefined
}

/**
 * Turn a `(input, init)` pair into one the bundled undici understands.
 *
 * This plugin bundles its own `undici`, so its `Request` class is a **different
 * class** from the one the platform `fetch` hands out. A `Request` built by the
 * platform is therefore not `instanceof` the bundled `Request`, and passing it
 * straight through made undici stringify it to `"[object Request]"` and reject
 * with `ERR_INVALID_URL` — instantly, before any socket, on every attempt and on
 * both channels. That is exactly the "four retries, none of them connected"
 * shape, and it is why a settings edit (which changes the request shape) could
 * make it disappear.
 *
 * So a foreign request is taken apart instead of forwarded: its URL, method,
 * headers, body and the rest are copied into a plain init the bundled undici can
 * read. The body is copied as bytes, never as decoded text. A `Request` this
 * plugin built itself is passed through untouched.
 * @param input - the fetch input.
 * @param init - the fetch init, if any.
 * @returns the input and init to call the bundled fetch with.
 */
export async function normaliseFetchCall(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<NormalisedCall> {
  if (typeof input === 'string' || input instanceof URL || input instanceof UndiciRequest) {
    const headers = headerPairs(init?.headers)
    return { input, init: headers === undefined ? init : { ...init, headers } }
  }
  if (input === null || typeof input !== 'object' || typeof input.url !== 'string') {
    // A genuinely bad input: let undici raise its own error for it.
    return { input, init }
  }
  const request = input
  const pairs = new Map<string, string>()
  for (const [name, value] of headerPairs(request.headers) ?? []) pairs.set(name.toLowerCase(), value)
  for (const [name, value] of headerPairs(init?.headers) ?? []) pairs.set(name.toLowerCase(), value)
  const next: RequestInit = { ...(init ?? {}) }
  if (next.method === undefined) next.method = request.method
  if (pairs.size > 0) next.headers = [...pairs]
  const carried: readonly (keyof RequestInit)[] = ['redirect', 'credentials', 'mode', 'cache', 'referrer', 'referrerPolicy', 'integrity', 'keepalive']
  for (const key of carried) {
    if (next[key] === undefined && request[key as keyof Request] !== undefined) {
      next[key] = request[key as keyof Request] as never
    }
  }
  if (next.signal === undefined && request.signal !== null) next.signal = request.signal
  // A Request exposes a stream; the bundled undici cannot take a stream from the
  // other undici, so the body is read back out of it. Read it as bytes: `text()`
  // decodes UTF-8, so every non-text body (recorded audio, uploads, archives)
  // came out with its invalid bytes replaced by U+FFFD and grew on the wire.
  if (next.body === undefined && request.body !== null) {
    next.body = typeof request.arrayBuffer === 'function'
      ? await request.arrayBuffer()
      : await request.text()
  }
  return { input: request.url, init: next }
}

/** Bind a fetch to one dispatcher, keeping the platform fetch's shape. */
function fetchWith(dispatcher: Dispatcher): typeof fetch {
  // undici's fetch and the platform fetch share a runtime shape but not a
  // nominal type; this cast is the whole boundary between the two views.
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = await normaliseFetchCall(input as string | URL | Request, init)
    return undiciFetch(
      call.input as unknown as Parameters<typeof undiciFetch>[0],
      { ...call.init, dispatcher } as unknown as Parameters<typeof undiciFetch>[1],
    )
  }) as unknown as typeof fetch
}

/**
 * Build one hardened channel.
 *
 * Without a proxy URL this is the direct channel — the one every unlisted host
 * uses, so it carries the same long connect ceiling, TCP keepalive, bounded
 * idle window, and transport retry as the proxied one. With a URL it is a
 * `ProxyAgent`, and its `connect.timeout` is what bounds the CONNECT tunnel
 * (the measured 10.5 s handshake that a 10 s default used to turn into
 * UND_ERR_CONNECT_TIMEOUT).
 * @param proxyUrl - the proxy endpoint, or undefined/empty for a direct channel.
 * @param options - stability settings and the retry reporter.
 * @returns the channel, ready to install.
 */
export function createHardenedChannel(proxyUrl: string | undefined, options: ChannelOptions): HardenedChannel {
  const agentOptions = agentOptionsOf(options.stability)
  const proxied = typeof proxyUrl === 'string' && proxyUrl.length > 0
  const dispatcher: Dispatcher = proxied
    ? new ProxyAgent(proxyAgentOptions(proxyUrl as string, options.stability, agentOptions))
    : new Agent(agentOptions as unknown as ConstructorParameters<typeof Agent>[0])
  const retryPolicy = {
    maxRetries: options.stability.retryCount,
    baseDelayMs: options.stability.retryDelayMs,
    retryOnPossibleDelivery: options.stability.retryOnPossibleDelivery,
    ...(options.onRetry === undefined ? {} : { onRetry: options.onRetry }),
  }
  // Timing sits inside the retry layer on purpose: one sample is one attempt, so
  // a connection that had to be re-dialled reads as two samples instead of one
  // misleadingly slow one.
  const channelFetch = fetchWith(dispatcher)
  const observed = options.observer === undefined
    ? channelFetch
    : options.observer.wrapFetch(proxied ? 'proxy' : 'direct', channelFetch)
  return {
    fetch: withTransportRetry(observed, retryPolicy),
    fetchOnce: observed,
    dispatcher,
    proxied,
    close: () => dispatcher.close(),
  }
}

/**
 * Create a fetch bound to a proxy dispatcher, hardened by the shipped defaults.
 *
 * Kept as the narrow, single-purpose entry point; the host half builds its
 * channels through {@link createHardenedChannel} so it can pass live settings.
 * @param proxyUrl - the proxy endpoint.
 * @returns the proxy-bound fetch and its dispatcher closer.
 */
export function createProxyFetch(proxyUrl: string): ProxyFetch {
  const channel = createHardenedChannel(proxyUrl, {
    stability: {
      connectTimeoutMs: 60_000,
      responseTimeoutMs: 300_000,
      streamIdleTimeoutMs: 0,
      retryCount: 0,
      retryDelayMs: 400,
      retryOnPossibleDelivery: true,
    },
  })
  return { fetch: channel.fetch, close: channel.close }
}

/** The two fetch shapes the routing layer chooses between. */
export interface RoutingChannels {
  /** The hardened proxy channel. */
  proxy: typeof fetch
  /** The hardened direct channel. */
  direct: typeof fetch
}

/** A URL's hostname, or `''` when it cannot be read. */
function hostnameOrEmpty(url: string): string {
  try {
    return hostnameOf(url)
  } catch {
    return ''
  }
}

/** Construction options for {@link createRoutingFetch}. */
export interface RoutingOptions {
  /** Extra attempts after the first; 0 sends every request exactly once. */
  retryCount: number
  /** First backoff before a retry, doubled per attempt and jittered. */
  baseDelayMs: number
  /** Whether a failure that may already have been delivered is retried too. */
  retryOnPossibleDelivery: boolean
  /**
   * How long an unproven channel gets to answer, in milliseconds.
   *
   * Absent takes {@link PROBE_TIMEOUT_MS}. The budget applies only while a host's
   * channel is still being decided (see `dsh-proxy/routing`); a host that has
   * already been settled is never cut off by it.
   */
  probeTimeoutMs?: number
  /**
   * Whether the configuration pins this hostname to the proxy.
   *
   * A pinned host has no direct path and therefore nothing to probe; the built-in
   * loopback/LAN exemption is applied here too, so a pinned name can never be
   * made to leave the machine.
   */
  forcedProxy?(hostname: string): boolean
  /** Called once per finished attempt: the record the user asked for. */
  onAttempt?(attempt: RouteAttempt): void
  /** Called once per retry, before its backoff. */
  onRetry?(attempt: RetryAttempt): void
}

/**
 * How many attempts a host may spend on *choosing* its channel.
 *
 * The memory's decision sequence is at most direct probe → proxy probe → direct
 * fallback, so three attempts always cover it. Those attempts are the routing
 * decision, not repeats of a channel that already answered, which is why they are
 * allowed even when `retryCount` is 0.
 */
const PROBE_ATTEMPTS = 3

/** A merged abort signal plus the cleanup its fallback path needs. */
interface MergedSignal {
  /** The signal the attempt hands to its channel. */
  signal: AbortSignal
  /** Detach the fallback listener, if one was installed. */
  release(): void
}

/**
 * Merge a caller's abort signal into the one a bounded attempt hands to its
 * channel, so Stop still cancels a probe immediately.
 *
 * `AbortSignal.any` is the platform answer and needs no cleanup. The manual
 * fallback exists for a runtime that predates it; it keeps one listener on the
 * caller's signal and removes it when the attempt ends.
 * @param caller - the caller's signal, if any.
 * @param controller - the controller that owns this attempt's deadline.
 * @returns the signal to pass on, plus its cleanup.
 */
function mergeSignal(
  caller: AbortSignal | null | undefined,
  controller: AbortController,
): MergedSignal {
  if (caller === null || caller === undefined) {
    return { signal: controller.signal, release: () => { /* nothing to detach */ } }
  }
  const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  if (typeof any === 'function') {
    return { signal: any.call(AbortSignal, [caller, controller.signal]), release: () => { /* GC'd with the signal */ } }
  }
  if (caller.aborted) {
    controller.abort(caller.reason)
    return { signal: controller.signal, release: () => { /* already aborted */ } }
  }
  const forward = (): void => controller.abort(caller.reason)
  caller.addEventListener('abort', forward, { once: true })
  return {
    signal: controller.signal,
    release: () => caller.removeEventListener('abort', forward),
  }
}

/**
 * Run one channel call, aborting it when the probe budget runs out.
 *
 * The budget is measured to the response headers, which is what "the channel
 * answered" means for routing; a streaming body that arrives afterwards is not
 * bounded by it. A budget of 0 means no deadline at all.
 * @param impl - the channel fetch.
 * @param input - the fetch input.
 * @param init - the fetch init, if any.
 * @param budgetMs - the deadline, in milliseconds; 0 disables it.
 * @param caller - the caller's abort signal, if any.
 * @returns the response, or a rejection carrying {@link PROBE_TIMEOUT_CODE}.
 */
async function attemptOnChannel(
  impl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  budgetMs: number,
  caller: AbortSignal | null,
): Promise<Response> {
  if (budgetMs <= 0) return impl(input, init)
  const controller = new AbortController()
  const merged = mergeSignal(caller, controller)
  const attemptInit: RequestInit = init === undefined
    ? { signal: merged.signal }
    : { ...init, signal: merged.signal }
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(
        new Error('dsh-proxy: no answer within ' + String(budgetMs) + 'ms'),
        { code: PROBE_TIMEOUT_CODE },
      )
      reject(error)
      controller.abort(error)
    }, budgetMs)
  })
  const call = impl(input, attemptInit)
  // The race owns this rejection; without a handler of its own the abandoned
  // call would surface as an unhandled rejection.
  void call.catch(() => { /* reported by the race */ })
  try {
    return await Promise.race([call, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    merged.release()
  }
}

/**
 * Wrap the two channels so each host is decided once and then kept on the
 * channel that answered.
 *
 * The direct argument is deliberately the plugin's **hardened direct** fetch
 * rather than the platform fetch: a host the configuration does not name still
 * gets the longer connect ceiling, the keepalive, and the transport retry.
 * Falling back to the platform fetch would put it back on undici's 10 second
 * connect timeout, which is the failure this plugin exists to remove.
 *
 * The strategy is {@link RouteMemory}'s, and it is what the user asked for: a
 * host that is on no list starts direct with a {@link PROBE_TIMEOUT_MS} budget;
 * answering settles it on direct for the session, and only a direct path that
 * stays silent hands it to the proxy (same budget). The channel that answers is
 * kept, so a healthy host never alternates, while a settled channel that then
 * fails outright still gets one probe of the other. A pinned host skips all of
 * it and stays on the proxy.
 *
 * Retrying is gated by whether the request can be sent again: the body must be
 * replayable and the caller must not have aborted. A failure that may already
 * have been delivered is resent only when `retryOnPossibleDelivery` is on — and
 * a failure carrying **no** transport code counts as possibly delivered, because
 * that is the case where refusing to move would strand the host on a channel
 * that does not work. What a failure never does is leave the host's decision
 * where it was: the memory advances even when the request itself must stop.
 * The probe sequence is the routing decision and is bounded by the memory to
 * three attempts. Once there is nothing left to try the original error is
 * rethrown unchanged, so the harness sees the transport code it always saw.
 * @param channels - the proxy fetch and the direct fetch.
 * @param memory - the per-host channel memory.
 * @param options - retry budget, probe deadline, pinning, and where attempts are recorded.
 * @returns the routing fetch.
 */
export function createRoutingFetch(
  channels: RoutingChannels,
  memory: RouteMemory,
  options: RoutingOptions,
): typeof fetch {
  const retries = Number.isFinite(options.retryCount) ? Math.max(0, Math.trunc(options.retryCount)) : 0
  const retryLimit = 1 + retries
  const maxAttempts = Math.max(retryLimit, PROBE_ATTEMPTS)
  const probeTimeoutMs = Number.isFinite(options.probeTimeoutMs) && (options.probeTimeoutMs as number) > 0
    ? Math.trunc(options.probeTimeoutMs as number)
    : PROBE_TIMEOUT_MS
  const forcedProxy = options.forcedProxy ?? (() => false)
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    // Read the call once, before any attempt. A caller-supplied `Request` is
    // consumed when its body is read, so retrying with the same object would
    // reject instantly with "Body is unusable" — a failure that carries no
    // transport code and used to strand the host on the channel that just
    // failed. Normalising once makes every attempt below send the same bytes.
    const call = await normaliseFetchCall(input as string | URL | Request, init)
    const requestInit = call.init
    const url = urlOf(call.input)
    const hostname = hostnameOrEmpty(url)
    const signal = requestInit?.signal ?? null
    // A loopback or LAN name never travels; a pinned host always does. Neither
    // has a channel to choose, so neither consults the memory.
    const exempt = hostname.length > 0 && isExemptHostname(hostname)
    const pinned = hostname.length > 0 && !exempt && forcedProxy(hostname)
    const decided = hostname.length > 0 && !exempt && !pinned
    const replayable = isReplayableRequest(requestInit)

    for (let attempt = 1; ; attempt++) {
      const decision: RouteDecision = exempt
        ? { channel: 'direct', probe: false, fallback: false }
        : pinned
          ? { channel: 'proxy', probe: false, fallback: false }
          : memory.decide(hostname)
      const channel = decision.channel
      const impl = channel === 'proxy' ? channels.proxy : channels.direct
      // Only an unproven channel is bounded, and only when the request can be
      // sent again: aborting a one-shot body to try the other channel would
      // truncate it.
      const budgetMs = decision.probe && replayable ? probeTimeoutMs : 0
      const startedAt = performance.now()
      try {
        const response = await attemptOnChannel(impl, call.input, requestInit, budgetMs, signal)
        if (decided) memory.settle(hostname, channel)
        options.onAttempt?.({
          hostname,
          attempt,
          maxAttempts,
          channel,
          ok: true,
          ms: Math.round(performance.now() - startedAt),
          probe: decision.probe,
          next: channel,
        })
        return response
      } catch (error) {
        // A caller's cancel is not the channel's verdict: it is recorded as
        // such, and it never moves the memory.
        const aborted = isAborted(signal)
        const code = aborted ? 'UND_ERR_ABORTED' : transportCodeOf(error)
        const message = error instanceof Error ? error.message : String(error)
        const timedOut = code === PROBE_TIMEOUT_CODE
        // How much the failure says about delivery. A known "not delivered" code
        // is safe to resend; a known "possibly delivered" one needs the switch;
        // and a failure with no code at all is treated as possibly delivered —
        // its whole point is that an unrecognised error must not freeze a host.
        const notDelivered = isRetryableTransportError(error, false)
        const possiblyDelivered = isRetryableTransportError(error, true) && !notDelivered
        const resendable = timedOut || notDelivered
          || (options.retryOnPossibleDelivery && (possiblyDelivered || code.length === 0))
        let next: RouteDecision | undefined
        let repeat = false
        if (aborted || !replayable) {
          // Nothing may be sent again: the failure is the caller's to see.
        } else if (!decided) {
          // A pinned or exempt host has no choice to make; it may still retry
          // its own channel while the budget allows.
          repeat = resendable && attempt < retryLimit
        } else {
          // The decision always moves on a failure. Advancing it sends nothing;
          // leaving it put is what pinned a host to the channel that had just
          // failed, so every later request opened with the same doomed probe.
          next = memory.failed(hostname, channel)
          if (next !== undefined) {
            if (!resendable) next = undefined
            // Every attempt of one request — including the probe sequence and
            // the fallback — counts against the same budget, so two concurrent
            // requests sharing the memory cannot walk the log past `n/n`.
            else if (attempt >= maxAttempts) next = undefined
          }
        }
        options.onAttempt?.({
          hostname,
          attempt,
          maxAttempts,
          channel,
          ok: false,
          ms: Math.round(performance.now() - startedAt),
          code,
          message,
          probe: decision.probe,
          ...(next === undefined && !repeat ? {} : { next: next?.channel ?? channel }),
        })
        if (next === undefined && !repeat) throw error
        // A probe that moves on is the routing decision, already explained by
        // the attempt record; only a genuine re-dial of the same channel or a
        // retry on a settled one is worth the transport-retry warning.
        if (repeat || (next !== undefined && !next.probe && !next.fallback)) {
          options.onRetry?.({
            attempt,
            maxRetries: Math.max(0, retryLimit - 1),
            code,
            url,
          })
        }
        await abortableSleep(retryDelayMs(options.baseDelayMs, attempt), signal)
        // The caller may have aborted during the sleep: surface the abort, not a stale retry.
        if (isAborted(signal)) throw error
      }
    }
  }) as typeof fetch
}
