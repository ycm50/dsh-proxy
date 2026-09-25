/**
 * Locale bundles for the http-proxy settings card.
 *
 * Both shipped languages are required together by `ctx.locale.register`, and
 * the key sets are checked against the namespace declaration in
 * `contract.ts` — so a key added to one dictionary and forgotten in the other
 * is a compile error rather than a raw key on screen.
 * @module dsh-http-proxy/client/locales
 */

/** English copy. */
export const en = {
  title: 'HTTP proxy',
  description: 'Send model-API requests through a forward proxy; everything else stays direct.',
  proxy: 'Proxy URL',
  proxyHint: 'http / https / socks4 / socks4a / socks5 / socks5h. Leave blank to switch the plugin off.',
  hosts: 'Proxy only these hosts',
  hostsHint: 'Blank means every model host is detected automatically. Otherwise only these are proxied — comma-separated, accepting host, host:port, URL, or a .domain suffix.',
  exclude: 'Excluded hosts',
  excludeHint: 'Never proxied, whatever else is configured — same entry forms as above.',
  suggestions: 'Known model hosts',
  suggestionsHint: 'Pick a known host to add it to this field.',
  suggestionsEmpty: 'Every known host is already listed.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  invalid: 'This value is not accepted.',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
}

/** Simplified Chinese copy. */
export const zh: Record<keyof typeof en, string> = {
  title: 'HTTP 代理',
  description: '给模型 API 请求配置正向代理；web 搜索等其它请求仍直连。',
  proxy: '代理地址',
  proxyHint: '支持 http / https / socks4 / socks4a / socks5 / socks5h；留空则插件不生效。',
  hosts: '只代理这些域名',
  hostsHint: '留空 = 自动代理所有模型域名；填写 = 只代理列出的这些域名（逗号分隔，支持域名 / 域名:端口 / URL / .域名后缀）。',
  exclude: '排除域名',
  excludeHint: '永远不走代理，优先级最高（写法同上）。',
  suggestions: '已知模型域名',
  suggestionsHint: '点选一个已知域名，把它加入本字段。',
  suggestionsEmpty: '已知域名都已列出。',
  overridden: '已覆盖',
  reset: '恢复默认',
  invalid: '该值不被接受。',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
}

/** Key domain of this plugin's dictionary. */
export type HttpProxyLocaleKey = keyof typeof en
