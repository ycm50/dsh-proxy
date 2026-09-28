/**
 * Client half of dsh-proxy: registers the `dsh-proxy` page in the
 * Settings panel's left-hand navigation, over the same `dsh-proxy` settings
 * namespace the Host half serves.
 *
 * DSH 0.1.7 split this apart. The panel's navigation is a list slot the
 * settings shell declares and projects into nav rows (`settings.section`),
 * and the form is reached through the settings domain's `configForms` service
 * rather than a namespace binding of this plugin's own. Registration is
 * guarded by `whileServed`, so a deployment that never composed the Host half
 * shows no row — the same discipline the bundled pages use.
 * @module dsh-proxy/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the `settings.section` slot declaration and the
// `ctx.configForms` augmentation.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the renderer-owned `ctx.slots` Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { HttpProxySection } from './section.js'
import { HttpProxyFormController } from './form-controller.js'
import type { HttpProxySettings } from './form-controller.js'
import { LOCALE_NS, PI_AI_NS, SECTION_ID, SECTION_ORDER, SETTINGS_NS } from './contract.js'
import { en, zh } from './locales.js'

export { LOCALE_NS, PI_AI_NS, SECTION_ID, SECTION_ORDER, SETTINGS_NS } from './contract.js'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Mount the dsh-proxy settings page.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(LOCALE_NS)
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-proxy: dictionaries')

  // The shared form and the describe mirror both outlive this fiber, so the
  // controller owns the subscriptions it opened and releases them on unload.
  const controller = new HttpProxyFormController(
    ctx,
    ctx.configForms.get<HttpProxySettings>(SETTINGS_NS),
    PI_AI_NS,
  )
  ctx.effect(() => () => controller.dispose(), 'dsh-proxy: form subscription')

  ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: SECTION_ORDER,
    label: () => t('title'),
    locale: LOCALE_NS,
    inject: () => controller.inject(),
  }, HttpProxySection))), 'dsh-proxy: settings page')
}
