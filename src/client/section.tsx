/**
 * The dsh-proxy settings page: the page the Settings panel's own left-hand
 * navigation opens, rendered in the content column beside the bundled ones.
 *
 * A plugin that owns a settings page draws the column contents — the shell
 * contributes the nav row — so this file owns the heading, the one-line intro,
 * and the three controls. The controls are the host's own `SettingsForm` +
 * `SettingsValueField`, which is what gives the page the overridden badge, the
 * reset-to-default control, the staged-draft save, and the read-only and
 * unavailable notices without this plugin restating any of them.
 * @module dsh-proxy/client/section
 */

import type { ReactElement, ReactNode } from 'react'
import { Button, SettingsForm, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsFieldState, SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HttpProxySectionProps, HttpProxyTranslate } from './contract.js'
import type { HostFieldName } from './form-controller.js'
import { matchesHostEntry, normalizeHostEntry, splitHostEntries } from '../hosts.js'
import css from './section.module.css'

/** The form frame's copy, read from this page's dictionary. */
function formLabels(t: HttpProxyTranslate): SettingsFormLabels {
  return {
    unavailable: t('unavailable'),
    readOnly: t('readOnly'),
    saveFailed: t('saveFailed'),
    save: t('save'),
    saving: t('saving'),
  }
}

/**
 * Append one host to a control's text, skipping one an entry already covers.
 *
 * Entries are umbrellas, so listing `commandcode.ai` already reaches
 * `api.commandcode.ai` — offering to add the child would only add a redundant
 * line the Host half would treat identically.
 */
function appendHost(current: string, host: string): string {
  const parts = splitHostEntries(current)
  const covered = parts.some((part) => {
    const entry = normalizeHostEntry(part)
    return entry !== undefined && matchesHostEntry(host, entry)
  })
  if (!covered) parts.push(host)
  return parts.join(', ')
}

/**
 * The known-host pick list, disclosed by the information button beside a host
 * field's label.
 *
 * It is a convenience, not the field's vocabulary: the control stays free
 * text, so a private gateway nothing here knows about is typed as usual. A
 * host the field already covers is left out rather than offered and then
 * deduplicated on the way in.
 */
function KnownHosts(props: {
  t: HttpProxyTranslate
  hosts: string[]
  current: string
  disabled: boolean
  onPick: (host: string) => void
}): ReactElement {
  const entries = splitHostEntries(props.current)
    .map(entry => normalizeHostEntry(entry))
    .filter((entry): entry is string => entry !== undefined)
  const options = props.hosts.filter(host => !entries.some(entry => matchesHostEntry(host, entry)))
  return (
    <div>
      <p>{options.length > 0 ? props.t('suggestionsHint') : props.t('suggestionsEmpty')}</p>
      {options.map(host => (
        <Button
          key={host}
          variant="ghost"
          size="sm"
          disabled={props.disabled}
          onClick={() => { props.onPick(host) }}
        >
          {host}
        </Button>
      ))}
    </div>
  )
}

/** One host field: the shared value field plus its pick list. */
function HostField(props: {
  t: HttpProxyTranslate
  id: string
  label: string
  hint: string
  state: SettingsFieldState
  suggestions: string[]
  disabled: boolean
  onEdit: (text: string) => void
  onReset: () => void
  onPick: (host: string) => void
}): ReactElement {
  const { t } = props
  const help: { label: string; content: ReactNode } = {
    label: t('suggestions'),
    content: (
      <KnownHosts
        t={t}
        hosts={props.suggestions}
        current={props.state.text}
        disabled={props.disabled}
        onPick={props.onPick}
      />
    ),
  }
  return (
    <SettingsValueField
      id={props.id}
      label={props.label}
      hint={props.hint}
      overriddenLabel={t('overridden')}
      resetLabel={t('reset')}
      invalidLabel={t('invalid')}
      help={help}
      disabled={props.disabled}
      {...props.state}
      onEdit={props.onEdit}
      onReset={props.onReset}
    />
  )
}

/**
 * Render the dsh-proxy settings page.
 * @param props - locale copy, the page snapshot, and its form actions.
 * @returns the page column.
 */
export function HttpProxySection(props: HttpProxySectionProps): ReactElement {
  const { t } = props
  const state = props.useHttpProxyForm(snapshot => snapshot)
  const disabled = !state.writable
  const hostField = (field: HostFieldName, id: string, label: string, hint: string): ReactElement => (
    <HostField
      t={t}
      id={id}
      label={label}
      hint={hint}
      state={state[field]}
      suggestions={state.suggestions}
      disabled={disabled}
      onEdit={text => { props.edit(field, text) }}
      onReset={() => { props.resetField(field) }}
      onPick={host => { props.edit(field, appendHost(state[field].text, host)) }}
    />
  )
  return (
    <section className={css.section} aria-labelledby="dsh-proxy-heading">
      <h2 className={css.heading} id="dsh-proxy-heading">{t('title')}</h2>
      <p className={css.intro}>{t('description')}</p>
      <SettingsForm
        labels={formLabels(t)}
        state={state}
        onSave={props.save}
        onDiscard={props.discard}
      >
        <SettingsValueField
          id="dsh-proxy-url"
          label={t('proxy')}
          hint={t('proxyHint')}
          placeholder="socks5://127.0.0.1:7890"
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t('invalid')}
          disabled={disabled}
          {...state.proxy}
          onEdit={text => { props.edit('proxy', text) }}
          onReset={() => { props.resetField('proxy') }}
        />
        {hostField('proxyHosts', 'dsh-proxy-hosts', t('hosts'), t('hostsHint'))}
        {hostField('excludeHosts', 'dsh-proxy-exclude', t('exclude'), t('excludeHint'))}
      </SettingsForm>
    </section>
  )
}
