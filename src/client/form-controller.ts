/**
 * The dsh-proxy settings page's staged form over the `dsh-proxy` settings
 * namespace, plus the read-only `llm-pi-ai` view that supplies the known-host
 * pick list for the two host fields.
 *
 * DSH 0.1.7 owns the staging contract: `SettingsFormModel` (the same model the
 * bundled settings pages use) holds the drafts, derives each control's
 * effective value and overridden badge from the shared config form, and writes
 * every edit in one revision-fenced `mutate` on save. This module only says how
 * this plugin's four fields convert between stored values and draft text,
 * where the pick list comes from, and how the page reaches the Host half to ask
 * what proxy this machine is configured with.
 * @module dsh-proxy/client/form-controller
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SettingsFormModel, settingsTextField } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  SettingsFieldSpec,
  SettingsFieldState,
  SettingsFormActions,
  SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm, SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  DEFAULT_DEEPSEEK_HOST,
  DEFAULT_MODEL_HOST_SUFFIXES,
  DEFAULT_MODEL_HOSTS,
  hostnameOf,
  normalizeHostEntry,
  splitHostEntries,
} from '../hosts.js'
import { SYSTEM_PROXY_CHANNEL, SYSTEM_PROXY_ENDPOINT } from '../rpc-contract.js'
import type { SystemProxyReading, SystemProxySource } from '../rpc-contract.js'
import { clientRpc } from './connection.js'

/** The `dsh-proxy` section fields this page edits (the wire shape). */
export interface HttpProxySettings {
  /** Proxy URL (http/https/socks4/socks4a/socks5/socks5h); empty = inactive. */
  proxy?: string
  /** Hostnames to proxy (empty = auto-detect every model host). */
  proxyHosts?: string[]
  /** Hostnames never proxied. */
  excludeHosts?: string[]
  /** Whether the machine's own proxy configuration supplies the address. */
  useSystemProxy?: boolean
}

/** The `llm-pi-ai` section subset this page reads for known model gateways. */
export interface PiAiSettings {
  providers?: Record<string, { baseURL?: string }>
}

/** The two host-list fields, which share one control shape. */
export type HostFieldName = 'proxyHosts' | 'excludeHosts'

/** One editable field of the page. */
export type FieldName = 'proxy' | HostFieldName | 'useSystemProxy'

/**
 * A host-list field: one line of text over a `string[]`.
 *
 * The stored section holds an array, the control holds comma-separated text,
 * and an empty draft clears the field — the same gesture as resetting it, so
 * emptying the box means "auto-detect" rather than "proxy nothing".
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
function settingsHostListField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (Array.isArray(value)
      ? value.filter((host): host is string => typeof host === 'string').join(', ')
      : ''),
    parse: (text) => {
      const hosts = splitHostEntries(text)
      return hosts.length === 0 ? { kind: 'clear' } : { kind: 'set', value: hosts }
    },
  }
}

/**
 * A boolean field: the checkbox holds `"true"`/`"false"` text, and a save
 * writes the boolean the Host schema declares.
 *
 * A checkbox has no third state, so unlike the text fields this one never
 * clears: unticking stores an explicit `false`, which is what the Host reads
 * anyway (an absent value defaults to `false`).
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
function settingsBooleanField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (value === true ? 'true' : 'false'),
    parse: (text) => ({ kind: 'set', value: text.trim().toLowerCase() === 'true' }),
  }
}

/** The sources a reading may name, so a wire value outside the union reads as `none`. */
const SYSTEM_PROXY_SOURCES: readonly SystemProxySource[] = [
  'windows-registry',
  'env',
  'macos-scutil',
  'linux-gsettings',
  'none',
]

/**
 * Coerce one wire value into a reading.
 *
 * The Host owns the shape, so this only defends the page against a Host that is
 * older, newer, or broken: anything missing reads as an empty field rather than
 * crashing the render.
 * @param value - the endpoint's success value.
 * @returns the reading, or undefined when there is no object to read.
 */
function asReading(value: unknown): SystemProxyReading | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Partial<SystemProxyReading>
  const source = SYSTEM_PROXY_SOURCES.find((candidate) => candidate === record.source) ?? 'none'
  const pacUrl = typeof record.pacUrl === 'string' && record.pacUrl.length > 0 ? record.pacUrl : undefined
  return {
    proxy: typeof record.proxy === 'string' ? record.proxy : '',
    source,
    detail: typeof record.detail === 'string' ? record.detail : '',
    platform: typeof record.platform === 'string' ? record.platform : '',
    ...(pacUrl === undefined ? {} : { pacUrl }),
  }
}

/** What the dsh-proxy settings page renders. */
export interface HttpProxyFormState extends SettingsFormShell {
  /** Staged proxy URL. */
  proxy: SettingsFieldState
  /** Staged proxy-only hosts, comma/whitespace separated. */
  proxyHosts: SettingsFieldState
  /** Staged excluded hosts, comma/whitespace separated. */
  excludeHosts: SettingsFieldState
  /** Staged "use the system proxy" switch. */
  useSystemProxy: SettingsFieldState
  /** Known model hostnames offered beside the host fields (free text still allowed). */
  suggestions: string[]
}

/** One answer to the page's "read the system proxy" request. */
export type SystemProxyRead =
  | { status: 'ok'; reading: SystemProxyReading }
  | { status: 'unavailable' }
  | { status: 'failed'; message: string }

/** The registration-side face the settings section injects. */
export interface HttpProxyFormFace extends SettingsFormActions {
  /** Form snapshot bound by the renderer as useHttpProxyForm. */
  hooks: { httpProxyForm: SnapshotStore<HttpProxyFormState> }
  /**
   * Ask the Host half for this machine's proxy configuration. Never rejects:
   * a deployment without a Connection channel answers `unavailable`.
   */
  readSystemProxy(): Promise<SystemProxyRead>
}

/** Bridges the `dsh-proxy` config form onto the settings page. */
export class HttpProxyFormController {
  private readonly form: SettingsFormModel<HttpProxySettings>
  private readonly mirror: SettingsDescribeFace
  private readonly store: SnapshotStore<HttpProxyFormState>
  private readonly disposers: Array<() => void> = []

  /**
   * @param ctx - the browser plugin context, for the shared settings mirror.
   * @param scope - the shared config form of the `dsh-proxy` Host entry.
   * @param knownNs - namespace whose configured gateways feed the pick list.
   */
  constructor(
    private readonly ctx: ClientContext,
    private readonly scope: ConfigForm<HttpProxySettings>,
    private readonly knownNs: string,
  ) {
    this.form = new SettingsFormModel<HttpProxySettings>(scope, [
      settingsTextField('proxy'),
      settingsHostListField('proxyHosts'),
      settingsHostListField('excludeHosts'),
      settingsBooleanField('useSystemProxy'),
    ])
    // The shared mirror is the one `settings.describe` reader in the browser;
    // reading the `llm-pi-ai` gateways through it keeps this page from opening
    // a second, possibly disagreeing view of the same document.
    this.mirror = ctx.configForms.describe()
    this.store = this.form.bind(() => this.projection())
    // The form model already republishes on its own scope; the pick list also
    // follows another plugin's section, which the model does not observe.
    this.disposers.push(this.mirror.subscribe(() => { this.publish() }))
    void this.mirror.ensure()
  }

  /** Stop observing the mirror and the form. Idempotent. */
  dispose(): void {
    for (const disposer of this.disposers.splice(0)) disposer()
    this.form.dispose()
  }

  /**
   * Build the face the section's slot registration injects.
   * @returns the page's snapshot and its form actions.
   */
  inject(): HttpProxyFormFace {
    return {
      hooks: { httpProxyForm: this.store },
      readSystemProxy: () => this.readSystemProxy(),
      ...this.form.actions(),
    }
  }

  /**
   * Ask the Host half what proxy this machine is configured with.
   *
   * The browser cannot read a registry, so the checkbox is a round trip: the
   * answer either carries a reading the page fills its field from, or says why
   * there is none. Nothing here throws — the page shows the failure and leaves
   * the form alone.
   * @returns the reading, or why there is none.
   */
  private async readSystemProxy(): Promise<SystemProxyRead> {
    const rpc = clientRpc(this.ctx)
    if (rpc === undefined) return { status: 'unavailable' }
    let value: unknown
    try {
      const result = await rpc.call(SYSTEM_PROXY_CHANNEL, SYSTEM_PROXY_ENDPOINT, {})
      if (!result.ok) return { status: 'failed', message: result.error.message }
      value = result.value
    } catch (cause) {
      return { status: 'failed', message: cause instanceof Error ? cause.message : String(cause) }
    }
    const reading = asReading(value)
    return reading === undefined
      ? { status: 'failed', message: 'the Host returned no reading' }
      : { status: 'ok', reading }
  }

  private publish(): void {
    this.store.set(this.projection())
  }

  private projection(): HttpProxyFormState {
    return {
      ...this.form.shell(),
      proxy: this.form.field('proxy'),
      proxyHosts: this.form.field('proxyHosts'),
      excludeHosts: this.form.field('excludeHosts'),
      useSystemProxy: this.form.field('useSystemProxy'),
      suggestions: this.suggestions(),
    }
  }

  /**
   * Hostnames offered by the host fields: the default DeepSeek host, the
   * built-in pi-ai catalog endpoints, every configured gateway, and what is
   * already saved.
   */
  private suggestions(): string[] {
    const hosts = new Set<string>([
      DEFAULT_DEEPSEEK_HOST,
      ...DEFAULT_MODEL_HOSTS,
      ...DEFAULT_MODEL_HOST_SUFFIXES,
    ])
    const saved = this.scope.getSnapshot().value ?? {}
    for (const list of [saved.proxyHosts, saved.excludeHosts]) {
      if (!Array.isArray(list)) continue
      for (const host of list) {
        if (typeof host !== 'string') continue
        // Normalize exactly like the Host half's routing, so the pick list
        // never offers a casing/port variant of a host that is already saved.
        const normalized = normalizeHostEntry(host)
        if (normalized !== undefined) hosts.add(normalized)
      }
    }
    const served = this.mirror.getSnapshot().view?.namespaces.find((ns) => ns.ns === this.knownNs)
    const known = served?.value as PiAiSettings | undefined
    for (const profile of Object.values(known?.providers ?? {})) {
      const baseURL = profile.baseURL
      if (typeof baseURL === 'string' && baseURL.length > 0) {
        try {
          hosts.add(hostnameOf(baseURL))
        } catch {
          // A malformed baseURL is pi-ai's to reject, not this page's to judge.
        }
      }
    }
    return [...hosts].sort()
  }
}
