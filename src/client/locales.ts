/**
 * Locale bundles for the dsh-proxy settings card.
 *
 * Both shipped languages are required together by `ctx.locale.register`, and
 * the key sets are checked against the namespace declaration in
 * `contract.ts` — so a key added to one dictionary and forgotten in the other
 * is a compile error rather than a raw key on screen.
 * @module dsh-proxy/client/locales
 */

/** English copy. */
export const en = {
  title: 'HTTP proxy',
  description: 'Send requests through a forward proxy. Only the hosts under Proxied hosts (and their subdomains) go through it; everything else stays direct, and Excluded hosts always stays direct. Proxy plugin installs too covers pnpm and git in child processes.',
  proxy: 'Proxy URL',
  proxyHint: 'http / https / socks4 / socks4a / socks5 / socks5h. Leave blank to switch the plugin off.',
  useSystemProxy: 'Use the system proxy',
  useSystemProxyHint: 'Ticking this reads the machine\'s proxy settings right away and fills the address above with what it finds. While it is ticked, the plugin prefers the system proxy.',
  proxySubprocesses: 'Proxy plugin installs too',
  proxySubprocessesHint: 'Writes the proxy into the child-process environment, so pnpm and git fetch and update plugins through it too — child processes do not see the host lists above. Only takes effect when the proxy address is http or https.',
  systemProxyReading: 'Reading the system proxy…',
  systemProxyDetected: 'Found system proxy',
  systemProxyNone: 'This machine configures no proxy, so the address above was left as it is.',
  systemProxyPac: 'This machine configures its proxy through an auto-config script (PAC), which this plugin cannot resolve',
  systemProxyUnavailable: 'This deployment has no Host connection, so the system proxy cannot be read.',
  systemProxyFailed: 'Could not read the system proxy',
  systemProxyFromWindows: 'Windows Internet Settings',
  systemProxyFromEnv: 'a proxy environment variable',
  systemProxyFromMacos: 'macOS network settings',
  systemProxyFromLinux: 'GNOME network settings',
  systemProxyFromNone: 'an unknown source',
  hosts: 'Proxy only these hosts',
  hostsHint: 'Only these hosts and their subdomains go through the proxy — comma-separated, accepting host, host:port, URL, or a .domain suffix. Blank proxies nothing.',
  exclude: 'Excluded hosts',
  excludeHint: 'Always direct, and judged before the list above — an excluded host stays direct even when it is also listed there. Same entry forms as above.',
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
  description: '给请求配置正向代理：只有「只代理这些域名」列出的域名及其子域名走代理，其余一律直连；「排除域名」永远直连。开启「插件安装/更新也走代理」还能覆盖子进程里的 pnpm / git。',
  proxy: '代理地址',
  proxyHint: '支持 http / https / socks4 / socks4a / socks5 / socks5h；留空则插件不生效。',
  useSystemProxy: '使用系统代理',
  useSystemProxyHint: '勾选后立即读取本机的系统代理设置，并把读到的地址填入上面的字段；勾选期间插件优先使用系统代理。',
  proxySubprocesses: '插件安装/更新也走代理',
  proxySubprocessesHint: '把代理写入子进程环境变量，使 pnpm / git 安装、更新插件时也走代理（子进程看不到上面的两个域名名单）；仅在代理地址为 http/https 时生效。',
  systemProxyReading: '正在读取系统代理…',
  systemProxyDetected: '已读取系统代理',
  systemProxyNone: '本机没有配置代理，上面的地址保持原样。',
  systemProxyPac: '本机通过自动配置脚本(PAC)设置代理，本插件无法解析',
  systemProxyUnavailable: '当前部署没有宿主连接通道，无法读取系统代理。',
  systemProxyFailed: '读取系统代理失败',
  systemProxyFromWindows: 'Windows Internet 设置',
  systemProxyFromEnv: '代理环境变量',
  systemProxyFromMacos: 'macOS 网络设置',
  systemProxyFromLinux: 'GNOME 网络设置',
  systemProxyFromNone: '来源未知',
  hosts: '只代理这些域名',
  hostsHint: '只有这些域名及其子域名走代理（逗号分隔，支持域名 / 域名:端口 / URL / .域名后缀）；留空 = 一个都不代理。',
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
