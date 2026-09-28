/**
 * The dsh-proxy settings page's staged form over the `dsh-proxy` settings
 * namespace, plus the read-only `llm-pi-ai` view that supplies the known-host
 * pick list for the two host fields.
 *
 * DSH 0.1.7 owns the staging contract: `SettingsFormModel` (the same model the
 * bundled settings pages use) holds the drafts, derives each control's
 * effective value and overridden badge from the shared config form, and writes
 * every edit in one revision-fenced `mutate` on save. This module only says how
 * this plugin's three fields convert between stored values and draft text, and
 * where the pick list comes from.
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

/** The `dsh-proxy` section fields this page edits (the wire shape). */
export interface HttpProxySettings {
  /** Proxy URL (http/https/socks4/socks4a/socks5/socks5h); empty = inactive. */
  proxy?: string
  /** Hostnames to proxy (empty = auto-detect every model host). */
  proxyHosts?: string[]
  /** Hostnames never proxied. */
  excludeHosts?: string[]
}

/** The `llm-pi-ai` section subset this page reads for known model gateways. */
export interface PiAiSettings {
  providers?: Record<string, { baseURL?: string }>
}

/** The two host-list fields, which share one control shape. */
export type HostFieldName = 'proxyHosts' | 'excludeHosts'

/** One editable field of the page. */
export type FieldName = 'proxy' | HostFieldName

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

/** What the dsh-proxy settings page renders. */
export interface HttpProxyFormState extends SettingsFormShell {
  /** Staged proxy URL. */
  proxy: SettingsFieldState
  /** Staged proxy-only hosts, comma/whitespace separated. */
  proxyHosts: SettingsFieldState
  /** Staged excluded hosts, comma/whitespace separated. */
  excludeHosts: SettingsFieldState
  /** Known model hostnames offered beside the host fields (free text still allowed). */
  suggestions: string[]
}

/** The registration-side face the settings section injects. */
export interface HttpProxyFormFace extends SettingsFormActions {
  /** Form snapshot bound by the renderer as useHttpProxyForm. */
  hooks: { httpProxyForm: SnapshotStore<HttpProxyFormState> }
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
    ctx: ClientContext,
    private readonly scope: ConfigForm<HttpProxySettings>,
    private readonly knownNs: string,
  ) {
    this.form = new SettingsFormModel<HttpProxySettings>(scope, [
      settingsTextField('proxy'),
      settingsHostListField('proxyHosts'),
      settingsHostListField('excludeHosts'),
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
      ...this.form.actions(),
    }
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
