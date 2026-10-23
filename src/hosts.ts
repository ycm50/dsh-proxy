/**
 * Browser-safe hostname helpers shared by the Host half (routing) and the
 * browser card (suggestions). No node imports, so either bundle can inline
 * this module without dragging in `undici`.
 * @module dsh-proxy/hosts
 */

/** The official DeepSeek adapter's default endpoint host. */
export const DEFAULT_DEEPSEEK_HOST = 'api.deepseek.com'

/**
 * Default model-API hostnames pi-ai's built-in providers use, so auto mode
 * proxies a catalog route (e.g. `google`) even when its profile names no
 * `baseURL`. Exact hostname matches; see {@link DEFAULT_MODEL_HOST_SUFFIXES}
 * for region- or resource-templated endpoints. This mirrors the endpoints the
 * installed pi-ai catalog ships (`builtinProviders()`); a pi-ai release that
 * adds a provider with a new default endpoint needs its host added here.
 */
export const DEFAULT_MODEL_HOSTS: readonly string[] = [
  'ai-gateway.vercel.sh',
  'api.ant-ling.com',
  'api.anthropic.com',
  'api.cerebras.ai',
  'api.cloudflare.com',
  'api.fireworks.ai',
  'api.groq.com',
  'api.individual.githubcopilot.com',
  'api.kimi.com',
  'api.minimaxi.com',
  'api.minimax.io',
  'api.mistral.ai',
  'api.moonshot.ai',
  'api.moonshot.cn',
  'api.openai.com',
  'api.together.ai',
  'api.x.ai',
  'api.xiaomimimo.com',
  'api.z.ai',
  'chatgpt.com',
  'gateway.ai.cloudflare.com',
  'generativelanguage.googleapis.com',
  'inference.baseten.co',
  'integrate.api.nvidia.com',
  'open.bigmodel.cn',
  'openrouter.ai',
  'router.huggingface.co',
  'token-plan-ams.xiaomimimo.com',
  'token-plan-cn.xiaomimimo.com',
  'token-plan-sgp.xiaomimimo.com',
  'token-plan.ap-southeast-1.maas.aliyuncs.com',
  'token-plan.cn-beijing.maas.aliyuncs.com',
]

/**
 * Default suffixes for templated pi-ai endpoints: `google-vertex` resolves its
 * catalog baseURL from `https://{location}-aiplatform.googleapis.com` (the
 * actual request lands on `us-central1-aiplatform.googleapis.com` and
 * siblings), and `azure-openai-responses` builds
 * `https://{resource}.openai.azure.com`. A suffix entry matches the bare
 * domain, its subdomains, and its hyphen-joined region hosts.
 */
export const DEFAULT_MODEL_HOST_SUFFIXES: readonly string[] = [
  '.aiplatform.googleapis.com',
  '.openai.azure.com',
]

/**
 * Extract the hostname from an absolute URL string or `URL`.
 * @param value - the URL to read.
 * @returns the lowercase hostname.
 */
export function hostnameOf(value: string | URL): string {
  return value instanceof URL ? value.hostname : new URL(value).hostname
}

/** Count one-character occurrences; enough for the `:` scan below. */
function countOf(value: string, needle: string): number {
  let count = 0
  for (let i = 0; i < value.length; i++) {
    if (value[i] === needle) count++
  }
  return count
}

/**
 * Normalize a user-entered host entry to the form `shouldProxy` matches
 * against (`new URL(url).hostname`). Accepts a plain hostname, `host:port`,
 * a bracketed or bare IPv6 literal, an absolute URL (scheme, port, and path
 * are all stripped), or a suffix entry (`*.example.com` or `.example.com`,
 * both kept as `.example.com`). Returns undefined when nothing usable
 * remains.
 * @param entry - a raw `proxyHosts` / `excludeHosts` entry.
 * @returns the normalized entry, or undefined for an empty/invalid entry.
 */
export function normalizeHostEntry(entry: string): string | undefined {
  const trimmed = entry.trim()
  if (trimmed.length === 0) return undefined
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).hostname.toLowerCase()
    } catch {
      return undefined
    }
  }
  const beforePath = trimmed.split('/')[0] ?? ''
  let hostPart: string
  if (beforePath.startsWith('[')) {
    // A bracketed IPv6 literal; a `:port` may follow the bracket.
    const close = beforePath.indexOf(']')
    hostPart = close === -1 ? beforePath : beforePath.slice(0, close + 1)
  } else if (countOf(beforePath, ':') === 1) {
    // Exactly one colon reads as `host:port`; a bare IPv6 literal has several.
    hostPart = beforePath.split(':')[0] ?? ''
  } else {
    hostPart = beforePath
  }
  let bare = hostPart.toLowerCase()
  if (bare.length === 0) return undefined
  // Bare IPv6 literals take the bracketed form URL hostnames carry.
  if (bare.includes(':') && !bare.startsWith('[')) bare = `[${bare}]`
  // `*.example.com` and `.example.com` are the same umbrella entry.
  if (bare.startsWith('*.')) bare = bare.slice(1)
  // URL hostnames never carry a trailing dot; drop it so the entry matches.
  if (bare.endsWith('.')) bare = bare.slice(0, -1)
  return bare.length > 0 ? bare : undefined
}

/**
 * Whether one hostname is covered by one normalized entry.
 *
 * An entry is an **umbrella**: it covers its own domain and every host built
 * on it, at any depth. Writing the umbrella domain is the whole statement —
 * `a.b` covers `a.b`, `*.a.b`, `*.*.a.b`, and so on — so `.a.b` and `*.a.b`
 * are accepted spellings of the same entry rather than a different, stronger
 * one. The hyphen rule is part of the umbrella because region-templated
 * endpoints are siblings, not children: `aiplatform.googleapis.com` covers
 * `us-central1-aiplatform.googleapis.com`, the shape `google-vertex` builds
 * from its `{location}` template.
 *
 * The comparison is on the request's URL hostname only, so an entry never
 * matches a path, a query, or a port.
 * @param hostname - the request hostname to test (already lowercased by `URL`).
 * @param entry - one entry from a normalized host set.
 * @returns whether the entry covers the hostname.
 */
export function matchesHostEntry(hostname: string, entry: string): boolean {
  const domain = entry.startsWith('.') ? entry.slice(1) : entry
  if (domain.length === 0) return false
  return hostname === domain
    || hostname.endsWith(`.${domain}`)
    || hostname.endsWith(`-${domain}`)
}

/**
 * Split a host field's text into entries. Commas and any whitespace separate,
 * so the browser page's one-line controls and the stored `string[]` section
 * agree on what the user typed.
 * @param text - the control's draft text.
 * @returns the non-empty entries, in order.
 */
export function splitHostEntries(text: string): string[] {
  return text.split(/[,\s]+/).filter(part => part.length > 0)
}

/**
 * One IPv4 octet, so a private-range match cannot accept \`10.999.1.1\`.
 */
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'

/**
 * The private, link-local, carrier-grade-NAT, and unspecified IPv4 blocks.
 *
 * These are the "physical space" this plugin must never route: a LAN service
 * (a local model server, an MCP endpoint on another machine, a router admin
 * page) reached through a forward proxy either fails outright or — worse —
 * travels out to a provider and back. The same reasoning that keeps loopback
 * direct keeps these direct, so the exemption is built in and cannot be
 * overridden by a host list.
 */
const PRIVATE_IPV4 = [
  new RegExp('^10\\.' + OCTET + '\\.' + OCTET + '\\.' + OCTET + '$'),
  new RegExp('^192\\.168\\.' + OCTET + '\\.' + OCTET + '$'),
  new RegExp('^172\\.(?:1[6-9]|2\\d|3[01])\\.' + OCTET + '\\.' + OCTET + '$'),
  new RegExp('^169\\.254\\.' + OCTET + '\\.' + OCTET + '$'),
  new RegExp('^100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.' + OCTET + '\\.' + OCTET + '$'),
  new RegExp('^0\\.' + OCTET + '\\.' + OCTET + '\\.' + OCTET + '$'),
]

/** Single-label and reserved suffixes that name a local network, never a public endpoint. */
const LOCAL_SUFFIXES: readonly string[] = [
  '.local',
  '.localdomain',
  '.lan',
  '.internal',
  '.home.arpa',
  '.localhost',
]

/**
 * Whether a hostname names a private/local network rather than the public
 * internet. Pure string comparison, never DNS — the decision must not depend
 * on the network being reachable (see \`isLoopbackHostname\` for the same rule).
 *
 * Covered: \`10/8\`, \`172.16/12\`, \`192.168/16\`, \`169.254/16\`, \`100.64/10\`,
 * \`0/8\`; IPv6 unique-local \`fc00::/7\` and link-local \`fe80::/10\` (including the
 * IPv4-mapped spellings Node's \`URL\` may hand over); and the local suffixes
 * above.
 * @param hostname - a URL hostname, bracketed or not, in any case.
 * @returns whether the host is a private/local address.
 */
export function isLanHostname(hostname: string): boolean {
  let host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (host.length === 0) return false
  // An IPv4-mapped IPv6 spelling carries the real address after this prefix.
  if (host.startsWith('::ffff:')) host = host.slice(7)
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true
  for (const suffix of LOCAL_SUFFIXES) {
    if (host.endsWith(suffix)) return true
  }
  if (host.indexOf('.') === -1 && host.indexOf(':') === -1) return true // a single label is a LAN name
  for (const pattern of PRIVATE_IPV4) {
    if (pattern.test(host)) return true
  }
  return false
}
