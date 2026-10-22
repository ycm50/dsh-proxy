/**
 * Proxy transport and host-routing helpers for `dsh-proxy`.
 *
 * The plugin does not touch DeepSeek Harness source. It installs a wrapper
 * around `globalThis.fetch` — which both the DeepSeek adapter's raw `fetch` and
 * the pi-ai SDK clients call — and routes model-API hosts through a proxy
 * dispatcher, leaving every other host on this plugin's own **hardened direct**
 * channel. Only the hosts the configuration names are routed; `excludeHosts`
 * always stays direct, and loopback and private networks are exempt on top of
 * that (see {@link isExemptHostname}).
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
import type { ChannelRotation, RouteAttempt, RouteChannel } from './routing.js'

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
 * The force list is the one list left: a host named there always travels through
 * the proxy, and it is the answer for a site that *can* be reached directly but
 * is throttled hard enough that trying is pointless — a mirror that answers in
 * 30 s direct and in 2 s through the proxy. A pinned host never alternates
 * channels (see `dsh-proxy/routing`): there is no direct attempt to rotate to.
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
 * read. A `Request` this plugin built itself is passed through untouched.
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
  // A Request built from a string exposes a stream; the bundled undici cannot
  // take a stream from the other undici, so the text is read back out of it.
  if (next.body === undefined && request.body !== null) next.body = await request.text()
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

/** The two fetch shapes the routing layer alternates between. */
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
   * Whether the configuration pins this hostname to the proxy.
   *
   * A pinned host has no direct path to rotate to, so it makes every attempt on
   * the proxy; the built-in loopback/LAN exemption is applied here too, so a
   * pinned name can never be made to leave the machine.
   */
  forcedProxy?(hostname: string): boolean
  /** Called once per finished attempt: the record the user asked for. */
  onAttempt?(attempt: RouteAttempt): void
  /** Called once per retry, before its backoff. */
  onRetry?(attempt: RetryAttempt): void
}

/**
 * Wrap the two channels so every request alternates between them on its retries.
 *
 * The direct argument is deliberately the plugin's **hardened direct** fetch
 * rather than the platform fetch: a host the configuration does not name still
 * gets the longer connect ceiling, the keepalive, and the transport retry.
 * Falling back to the platform fetch would put it back on undici's 10 second
 * connect timeout, which is the failure this plugin exists to remove.
 *
 * The strategy is {@link ChannelRotation}'s: the first attempt of a host goes
 * direct, and **every** attempt after it takes the other channel — so a run of
 * retries reads direct, proxy, direct, proxy, and one broken path can never
 * consume a whole turn while the other one is healthy. The cursor moves on
 * success too, which is what keeps both paths in use instead of trusting one on
 * the strength of a single good minute. A pinned host skips the rotation.
 *
 * Retrying is still gated the way the transport layer always gated it: the body
 * must be replayable, the caller must not have aborted, and the failure must
 * qualify — a possibly-delivered failure only when `retryOnPossibleDelivery` is
 * on, which is the same rule the single-channel retry applies. Once the budget is
 * spent the original error is rethrown unchanged, so the harness sees the
 * transport code it always saw.
 * @param channels - the proxy fetch and the direct fetch.
 * @param rotation - the per-host channel rotation.
 * @param options - retry budget, pinning, and where attempts are recorded.
 * @returns the routing fetch.
 */
export function createRoutingFetch(
  channels: RoutingChannels,
  rotation: ChannelRotation,
  options: RoutingOptions,
): typeof fetch {
  const maxAttempts = Math.max(1, 1 + (Number.isFinite(options.retryCount) ? Math.max(0, Math.trunc(options.retryCount)) : 0))
  const forcedProxy = options.forcedProxy ?? (() => false)
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input as string | URL | Request)
    const hostname = hostnameOrEmpty(url)
    const signal = init?.signal ?? null
    // A loopback or LAN name never travels; a pinned host always does. Neither
    // has a choice to rotate, so neither consults the rotation at all.
    const exempt = hostname.length > 0 && isExemptHostname(hostname)
    const pinned = hostname.length > 0 && !exempt && forcedProxy(hostname)
    const rotate = hostname.length > 0 && !exempt && !pinned
    const replayable = isReplayableRequest(init)

    for (let attempt = 1; ; attempt++) {
      const channel: RouteChannel = exempt ? 'direct' : pinned ? 'proxy' : rotation.channelFor(hostname)
      const impl = channel === 'proxy' ? channels.proxy : channels.direct
      const startedAt = performance.now()
      try {
        const response = await impl(input, init)
        options.onAttempt?.({
          hostname,
          attempt,
          maxAttempts,
          channel,
          ok: true,
          ms: Math.round(performance.now() - startedAt),
        })
        // The attempt is over, so the cursor moves: the next one takes the
        // other channel whether this one answered or not.
        if (rotate) rotation.record(hostname)
        return response
      } catch (error) {
        // A caller's cancel is not the channel's verdict: it is recorded as
        // such, and it never moves the rotation.
        const aborted = isAborted(signal)
        const code = aborted ? 'UND_ERR_ABORTED' : transportCodeOf(error)
        options.onAttempt?.({
          hostname,
          attempt,
          maxAttempts,
          channel,
          ok: false,
          ms: Math.round(performance.now() - startedAt),
          code,
        })
        if (rotate) rotation.record(hostname)
        const worthRetrying = attempt < maxAttempts
          && replayable
          && !aborted
          && isRetryableTransportError(error, options.retryOnPossibleDelivery)
        if (!worthRetrying) throw error
        options.onRetry?.({
          attempt,
          maxRetries: maxAttempts - 1,
          code,
          url,
        })
        await abortableSleep(retryDelayMs(options.baseDelayMs, attempt), signal)
        // The caller may have aborted during the sleep: surface the abort, not a stale retry.
        if (isAborted(signal)) throw error
      }
    }
  }) as typeof fetch
}
