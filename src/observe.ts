/**
 * Per-request timing for the two channels: the numbers that turn "the first
 * token got slower" into a decision.
 *
 * Why this exists: every fix for first-token latency is a bet about where the
 * time goes — a handshake inside a proxy tunnel, a dial that a warm pool would
 * have skipped, or the gateway itself thinking. Without a record of *which*
 * connection carried each request and how long it took to answer, those bets
 * are guesses. The measurements that motivated this module (a local proxy
 * adding 1.3-1.6 s of tunnel cost per fresh connection, and a direct path whose
 * time-to-first-byte swung between 0.7 s and 6.2 s on the same host) were only
 * visible with exactly these three numbers.
 *
 * Design rules, all of them about not disturbing what is measured:
 *   - **Off by default.** The host half constructs an observer only when the
 *     environment asks for one, so the shipped request path keeps no timer, no
 *     ring buffer, and no diagnostics subscription.
 *   - **The response is never rebuilt.** The first-chunk time is read from
 *     `response.clone()`, which leaves the object the caller receives — its
 *     status, headers, `url`, and body identity — untouched. A reconstructed
 *     `Response` would silently drop `url` and `redirected`.
 *   - **The clone is cancelled after one chunk**, so a streaming body is not
 *     buffered a second time for the rest of its life.
 *   - **Connection freshness comes from undici itself**, via the
 *     `undici:client:beforeConnect` diagnostics channel, rather than from a
 *     guess about pool internals.
 * @module dsh-proxy/observe
 */

import { channel as diagnosticsChannel } from 'node:diagnostics_channel'
import { hostnameOf } from './hosts.js'

/** Which channel carried one request. */
export type ObservedChannel = 'proxy' | 'direct'

/** What one request looked like from inside the plugin. */
export interface RequestSample {
  /** Wall-clock start, for lining samples up with a log. */
  at: number
  /** The channel the routing layer chose. */
  channel: ObservedChannel
  /** Uppercase request method, when the input carried one. */
  method: string
  /** `scheme://host[:port]`, with no path, so tokens never reach the log. */
  origin: string
  /** Response status, or 0 when the request failed before headers. */
  status: number
  /** Dispatch to response headers: dial + handshake + upload + first response. */
  headersMs: number
  /** Headers to the first `text/event-stream` chunk — the first token. */
  firstChunkMs: number | null
  /** Whether this request had to dial a new connection (no warm socket). */
  freshConnection: boolean
}

/** Aggregate shape for one channel. */
export interface ObserverStats {
  /** Requests measured on this channel. */
  requests: number
  /** How many of them had to open a new connection. */
  fresh: number
  /** Median time to response headers, in milliseconds. */
  headersP50: number
  /** 95th percentile time to response headers, in milliseconds. */
  headersP95: number
  /** Median time to the first streamed chunk, or null when none was measured. */
  firstP50: number | null
  /** 95th percentile time to the first streamed chunk, or null. */
  firstP95: number | null
}

/** Everything the summary of one observer holds. */
export interface ObserverSummary {
  /** Samples currently retained (the ring is bounded). */
  samples: number
  proxy: ObserverStats
  direct: ObserverStats
}

/** Construction options for {@link ProxyObserver}. */
export interface ObserverOptions {
  /** One line per finished request, plus a periodic summary. */
  log?(line: string): void
  /** How many samples the ring keeps (default 50). */
  capacity?: number
  /** Emit a summary line after this many samples (default 20, 0 disables). */
  summaryEvery?: number
  /** Injectable clock, so tests do not depend on wall time. */
  now?(): number
}

/** A fetch-shaped function; the observer wraps one of these per channel. */
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** The absolute URL string of a fetch input, without throwing. */
function urlOfInput(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  const candidate = input as { url?: unknown } | null | undefined
  return typeof candidate?.url === 'string' ? candidate.url : ''
}

/** `scheme://host` for a URL string, or `''` when it cannot be parsed. */
function originOf(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.protocol + '//' + parsed.host
  } catch {
    return ''
  }
}

/** The hostname a URL points at, or `''` when it cannot be parsed. */
function hostnameOfUrl(url: string): string {
  try {
    return hostnameOf(url)
  } catch {
    return ''
  }
}

/** The method a fetch input means, uppercased; `GET` when it carries none. */
function methodOf(input: RequestInfo | URL, init: RequestInit | undefined): string {
  const fromInit = init?.method
  if (typeof fromInit === 'string' && fromInit.length > 0) return fromInit.toUpperCase()
  const fromRequest = (input as { method?: unknown } | null | undefined)?.method
  if (typeof fromRequest === 'string' && fromRequest.length > 0) return fromRequest.toUpperCase()
  return 'GET'
}

/**
 * Nearest-rank percentile over a copy of the values.
 * @param values - measurements, in any order.
 * @param percent - 0-100.
 * @returns the percentile, or 0 for an empty set.
 */
function percentileOf(values: readonly number[], percent: number): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((left, right) => left - right)
  const rank = Math.ceil((percent / 100) * sorted.length) - 1
  const index = Math.min(sorted.length - 1, Math.max(0, rank))
  return sorted[index] ?? 0
}

/** One channel's aggregate, from its samples. */
function statsOf(samples: readonly RequestSample[]): ObserverStats {
  const headers = samples.map((sample) => sample.headersMs)
  const first = samples
    .map((sample) => sample.firstChunkMs)
    .filter((value): value is number => value !== null)
  return {
    requests: samples.length,
    fresh: samples.filter((sample) => sample.freshConnection).length,
    headersP50: percentileOf(headers, 50),
    headersP95: percentileOf(headers, 95),
    firstP50: first.length === 0 ? null : percentileOf(first, 50),
    firstP95: first.length === 0 ? null : percentileOf(first, 95),
  }
}

/** One finished request as a log line. */
function describeSample(sample: RequestSample): string {
  const first = sample.firstChunkMs === null ? 'n/a' : sample.firstChunkMs + 'ms'
  return 'dsh-proxy: ' + sample.method + ' ' + sample.origin + ' via ' + sample.channel
    + (sample.freshConnection ? ' (new connection)' : ' (reused connection)')
    + ' -> ' + sample.status
    + ' headers=' + sample.headersMs + 'ms first=' + first
}

/** One channel's aggregate as a log line. */
function describeStats(label: string, stats: ObserverStats): string {
  const first = stats.firstP50 === null
    ? 'first n/a'
    : 'first p50=' + stats.firstP50 + 'ms p95=' + stats.firstP95 + 'ms'
  return label + ' ' + stats.requests + 'x (fresh ' + stats.fresh + ')'
    + ' headers p50=' + stats.headersP50 + 'ms p95=' + stats.headersP95 + 'ms ' + first
}

/**
 * Records what each channel's requests cost, and reports it.
 *
 * One observer belongs to one plugin instance: it subscribes to the process-wide
 * diagnostics channel while it lives and must be disposed with the fiber.
 */
export class ProxyObserver {
  readonly #samples: RequestSample[] = []
  /** Dials seen per hostname, so a request can tell a warm socket from a new one. */
  readonly #dials = new Map<string, number>()
  readonly #dialChannel: ReturnType<typeof diagnosticsChannel>
  readonly #capacity: number
  readonly #summaryEvery: number
  readonly #clock: () => number
  readonly #onBeforeConnect: (message: unknown) => void
  #log: ((line: string) => void) | undefined
  #sinceSummary = 0
  #disposed = false

  constructor(options: ObserverOptions = {}) {
    this.#capacity = Math.max(1, Math.trunc(options.capacity ?? 50))
    this.#summaryEvery = Math.max(0, Math.trunc(options.summaryEvery ?? 20))
    this.#clock = options.now ?? (() => globalThis.performance.now())
    this.#log = options.log
    // Counting dials is the only reliable, version-independent way to tell a
    // reused socket from a fresh one: undici publishes this channel from inside
    // `Client.connect`, which runs synchronously while the request is dispatched.
    this.#onBeforeConnect = (message: unknown) => {
      const hostname = (message as { connectParams?: { hostname?: unknown } } | null | undefined)
        ?.connectParams?.hostname
      if (typeof hostname !== 'string' || hostname.length === 0) return
      this.#dials.set(hostname, (this.#dials.get(hostname) ?? 0) + 1)
    }
    this.#dialChannel = diagnosticsChannel('undici:client:beforeConnect')
    this.#dialChannel.subscribe(this.#onBeforeConnect)
  }

  /** How many dials this observer has seen for one hostname. */
  #dialCount(hostname: string): number {
    return hostname.length === 0 ? 0 : (this.#dials.get(hostname) ?? 0)
  }

  /** Keep the newest sample, dropping the oldest once the ring is full. */
  #record(sample: RequestSample): void {
    this.#samples.push(sample)
    while (this.#samples.length > this.#capacity) this.#samples.shift()
  }

  /** Report one finished request, then the periodic summary when it is due. */
  #report(sample: RequestSample): void {
    if (this.#disposed) return
    this.#log?.(describeSample(sample))
    this.#sinceSummary += 1
    if (this.#summaryEvery === 0 || this.#sinceSummary < this.#summaryEvery) return
    this.#sinceSummary = 0
    const summary = this.summary()
    this.#log?.('dsh-proxy: ' + String(summary.samples) + ' recent requests — '
      + describeStats('proxy', summary.proxy) + ' · ' + describeStats('direct', summary.direct))
  }

  /**
   * Read the first streamed chunk of a response without disturbing it.
   *
   * Only `text/event-stream` is sampled, because that is where "first byte"
   * means "first token"; a JSON body or a download would only report the
   * transfer cost. `clone()` tees the body so the caller's `Response` keeps its
   * identity, and the clone is cancelled after the first chunk so nothing is
   * buffered behind the caller's own reads.
   * @param response - the response handed to the caller.
   * @param startedAt - when the request was dispatched, on the observer clock.
   * @returns the first-chunk time in milliseconds, or null when not measurable.
   */
  #watchFirstChunk(response: Response, startedAt: number): Promise<number | null> {
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream') || response.body === null) {
      return Promise.resolve(null)
    }
    let clone: Response
    try {
      clone = response.clone()
    } catch {
      // A body already locked or disturbed is not this module's to touch.
      return Promise.resolve(null)
    }
    const reader = clone.body?.getReader()
    if (reader === undefined) return Promise.resolve(null)
    return (async () => {
      try {
        const { done } = await reader.read()
        return done ? null : Math.round(this.#clock() - startedAt)
      } catch {
        // Cancelling a stream proves nothing about its latency.
        return null
      } finally {
        void reader.cancel().catch(() => { /* already gone */ })
      }
    })()
  }

  /**
   * Wrap one channel's fetch so every attempt is measured.
   *
   * Wrapping happens *inside* the transport-retry layer, so one sample is one
   * attempt: a retried connection shows up as two samples instead of one
   * misleadingly slow one.
   * @param channel - which channel this fetch belongs to.
   * @param fetchImpl - the channel's own fetch.
   * @returns the timing wrapper, shaped exactly like the fetch it wraps.
   */
  wrapFetch(channel: ObservedChannel, fetchImpl: FetchLike): FetchLike {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (this.#disposed) return fetchImpl(input, init)
      const url = urlOfInput(input)
      const origin = originOf(url)
      const hostname = hostnameOfUrl(url)
      const dialsBefore = this.#dialCount(hostname)
      const startedAt = this.#clock()
      let response: Response
      try {
        response = await fetchImpl(input, init)
      } catch (error) {
        // A failed attempt is the interesting one when chasing a first token:
        // record it, then let the retry layer see the original rejection.
        const failure: RequestSample = {
          at: Date.now(),
          channel,
          method: methodOf(input, init),
          origin,
          status: 0,
          headersMs: Math.round(this.#clock() - startedAt),
          firstChunkMs: null,
          freshConnection: this.#dialCount(hostname) > dialsBefore,
        }
        this.#record(failure)
        this.#report(failure)
        throw error
      }
      const sample: RequestSample = {
        at: Date.now(),
        channel,
        method: methodOf(input, init),
        origin,
        status: response.status,
        headersMs: Math.round(this.#clock() - startedAt),
        firstChunkMs: null,
        freshConnection: this.#dialCount(hostname) > dialsBefore,
      }
      this.#record(sample)
      // The first token can trail the headers by seconds; report once it lands
      // (or immediately, when this response has no token stream to wait for).
      void this.#watchFirstChunk(response, startedAt).then((firstChunkMs) => {
        sample.firstChunkMs = firstChunkMs
        this.#report(sample)
      })
      return response
    }
  }

  /** The newest samples, oldest first. */
  recent(limit?: number): RequestSample[] {
    if (limit === undefined || limit >= this.#samples.length) return this.#samples.slice()
    return this.#samples.slice(this.#samples.length - Math.max(0, limit))
  }

  /** Aggregate the retained samples per channel. */
  summary(): ObserverSummary {
    const proxy = this.#samples.filter((sample) => sample.channel === 'proxy')
    const direct = this.#samples.filter((sample) => sample.channel === 'direct')
    return { samples: this.#samples.length, proxy: statsOf(proxy), direct: statsOf(direct) }
  }

  /** Forget every sample and dial count, keeping the subscription. */
  reset(): void {
    this.#samples.length = 0
    this.#dials.clear()
    this.#sinceSummary = 0
  }

  /** Stop listening to the diagnostics channel; a disposed observer records nothing. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#dialChannel.unsubscribe(this.#onBeforeConnect)
    this.#samples.length = 0
    this.#dials.clear()
  }
}

/**
 * Build an observer from an environment value, so the host half can decide with
 * one call whether instrumentation is on.
 *
 * Off is the default and stays the default: the request path ships without a
 * timer, a ring buffer, or a diagnostics subscription.
 * @param raw - the environment value (`DSH_PROXY_DEBUG`).
 * @param options - log sink and sizing, as {@link ObserverOptions}.
 * @returns the observer, or undefined when the value does not ask for one.
 */
export function observerFromEnv(raw: string | undefined, options: ObserverOptions = {}): ProxyObserver | undefined {
  const value = (raw ?? '').trim().toLowerCase()
  if (value.length === 0) return undefined
  if (value === '0' || value === 'false' || value === 'off' || value === 'no') return undefined
  return new ProxyObserver(options)
}
