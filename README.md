# dsh-proxy

给 DeepSeek Harness（DSH）加「模型请求走代理、其余请求直连」的能力，**不改任何 DSH 官方代码**。代理地址可以手填，也可以在设置页勾一下「使用系统代理」，直接读本机（Windows / macOS / Linux）的代理设置。

实现方式是在 host 进程的 `globalThis.fetch` 上包一层：命中域名集合的请求走代理，其它（web 搜索、网页抓取、MCP…）照旧直连。卸载即完全恢复原状——profile 里那一行设置也会被插件自己收回（见「清空即自清理」）。

## 兼容性

| 插件版本 | 需要的 DSH |
| --- | --- |
| **0.4.x** | **≥ 0.1.7-rc.2**（新增「使用系统代理」；读取走 Connection 的 `/api` 精确路由，已在 DSH 0.2.0-rc.1 上实测） |
| 0.3.x | ≥ 0.1.7-rc.2（包名 / entry id 均为 `dsh-proxy`） |
| 0.2.x | ≥ 0.1.7-rc.2（包名 / entry id 为 `dsh-http-proxy` / `http-proxy`） |
| 0.1.3 及更早 | 0.1.2-alpha.2 时代的插件 API，DSH 0.1.7 起已移除 |

DSH 0.1.7 重做了设置这一层：`settings.installSection`、客户端 `settingsScope` 服务、`settings.plugin.item` 插槽全部删除。0.2.x 起改为 —— Host 侧把 `Config` 各字段标记 `volatile()`，靠 `loader/volatile-update` 热更新；客户端注册到设置外壳的 `settings.section` 插槽（即设置面板左侧导航），表单用官方的 `SettingsForm` / `SettingsFormModel`。

## 安装

```bash
dsh plugin --profile <profile名> add dsh-proxy@github:ycm50/dsh-proxy
```

`lib/` 已提交，安装时直接取用，无需构建。装完**重启一次 DSH**。

也可以从本地 tarball 装（`pnpm pack` 生成，见「开发」）：

```bash
dsh plugin --profile <profile名> add dsh-proxy@file:/绝对路径/dsh-proxy-0.3.0.tgz
```

> 尚未发布到 npm。发布后可改用 `dsh plugin --profile <profile名> add dsh-proxy@0.3.0`。

### 从 0.2.x 升级

0.3.0 把包名与 entry id 统一成了 `dsh-proxy`；0.2.x 是 `dsh-http-proxy` / `http-proxy`。升级做两件事：

1. 装新包并把旧包移除：`dsh plugin --profile <profile名> add dsh-proxy@…`、`dsh plugin --profile <profile名> remove dsh-http-proxy`；
2. 若插件在 `dsh.profile.bundles` 里，把那一项从 `dsh-http-proxy` 改成 `dsh-proxy`，然后重启。

设置不会自动迁移：0.2.x 写在 profile 补丁里的 `id: http-proxy` 行会被新版本**清理掉**（见「清空即自清理」），装好后重新填一次即可。

## 配置

**设置面板 → 左侧导航「HTTP 代理」**，填好点保存，下一次请求即生效，无需重启。

| 字段 | 说明 |
| --- | --- |
| 代理地址 | `http` / `https` / `socks4` / `socks4a` / `socks5` / `socks5h`。**留空 = 插件不生效** |
| 使用系统代理 | 勾选后**立即**读取本机代理设置并填入「代理地址」；勾选期间优先使用系统代理（见下） |
| 只代理这些域名 | **留空 = 自动识别所有模型域名**；填写 = 只代理这些域名 |
| 排除域名 | 永远直连，优先于上一项 |

也可以只设环境变量，等价于「代理地址」（域名过滤仍走默认自动识别）：

```powershell
$env:DSH_HTTP_PROXY = 'socks5://127.0.0.1:7890'
```

> 环境变量名保持 `DSH_HTTP_PROXY`，它不属于包名 / entry id，0.3.0 的更名没有动它（DSH 自带的进程级代理读的是 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`，与本插件互不影响）。

### 使用系统代理

设置页「代理地址」下面有一个「使用系统代理」勾选框：

- **勾选的那一刻**，浏览器就向 Host 要一次本机代理设置，把读到的地址填进「代理地址」栏（`http://127.0.0.1:10808` 这种形式），并在下面用一行字说明读到了什么、来自哪里。这一步不用先保存——填好后再按「保存」即可。
- **勾选期间**，插件优先使用系统代理：只要配置刷新就重读一次，所以本机代理关掉、换端口，重载插件后立刻跟随；系统代理读不到时回落到手填的「代理地址」，再回落到 `DSH_HTTP_PROXY`。
- **取消勾选**只是取消这个优先级，不会清掉已经填好的地址；Host 通道不可用（例如不是 Web 版部署）时，勾选框会直接说明读不到。

只读、只走本机命令，顺序如下：

| 平台 | 来源 |
| --- | --- |
| Windows | `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 的 `ProxyEnable` / `ProxyServer`（系统「设置 → 网络和 Internet → 代理」和各类代理客户端写的就是这里）。`ProxyServer` 两种写法都认：`127.0.0.1:10808`，或 `http=…;https=…;socks=…`——本插件代理的是 HTTPS 请求，所以优先取 `https=` 那条，`socks=` 归一化成 `socks5://` |
| macOS | `scutil --proxy`：优先启用中的 HTTPS / HTTP / SOCKS 项 |
| Linux | GNOME `org.gnome.system.proxy`：manual 模式下的 https / http / socks |
| 兜底 | `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`（大小写拼法都认，按此顺序） |

只接受能直接用的代理：系统若用自动配置脚本（PAC，`AutoConfigURL`），插件无法解析脚本，设置页会明说「本机通过自动配置脚本(PAC)设置代理，本插件无法解析」，并把地址留原样。

读取发生在 Host 进程内（Windows 一次 `reg.exe query`，毫秒级），不联网、不改动任何系统设置，也不涉及你的凭据。

### 域名条目 = 总域名

填一个域名就覆盖它的**整棵子树**，任意层级：

| 填写 | 覆盖 |
| --- | --- |
| `a.b` | `a.b`、`*.a.b`、`*.*.a.b` …… |
| `*.a.b` / `.a.b` | 同上（等价写法，`*.` 会被归一化掉） |
| `aiplatform.googleapis.com` | 另外覆盖 `us-central1-aiplatform.googleapis.com` 这类**连字符区域端点** |

`域名:端口`、`https://域名/路径` 会归一化成域名；大小写不敏感。**排除用同一套语义**：排 `a.b` 是整棵树直连，排 `api.a.b` 只把那个子域捞回来。

`proxyHosts` 留空时的自动识别范围：`api.deepseek.com`、`DEEPSEEK_BASE_URL` 指向的域名、`llm-pi-ai` 里配置的自定义网关、pi-ai 内置 provider 的默认端点。

### 清空即自清理：profile 里不留残行

DSH 把本插件的设置写成 `profiles/<profile>/cordis.patch.yml` 里的一行 id 定向覆盖：

```yaml
- id: dsh-proxy
  name: dsh-proxy
  config:
    proxy: http://127.0.0.1:10808
```

DSH 自己不会收这一行：它只摘掉 bundle，行本身留着。所以**插件按 DSH 自己的状态判断「这是不是被关掉了」，然后把它收回去**。卸载（或从 `dsh.profile.bundles` 里移除、以及在插件页把开关关掉）时整行连同设置一起消失：

```yaml
# 关掉之后，这一行不在了
- id: other-plugin
  ...
```

| 你做了什么 | profile 里的这一行 |
| --- | --- |
| **关掉插件**（「已安装」列表里的开关，或从 `dsh.profile.bundles` 移除）／**卸载** | **整行删掉**（含 `config`）。此时 bundle 层不再 insert 这个条目，删行不会把它重新打开 |
| 只在插件页里关掉**某个行**（DSH 会往这一行写 `disabled: true`） | 保留这一行与 `disabled: true`，**`config:` 整块清掉**。整行删掉会让 bundle 的 insert 把它重新打开，所以只收回设置 |
| 代理地址为空、「只代理这些域名」「排除域名」也为空、「使用系统代理」没勾选 | 运行时就把这一行收掉——这份设置什么都没携带 |
| 重启 / 重载 / 更新插件 | **不动**。重载和关掉在 Cordis 里都是拆 fiber，分不清就会变成「每次重启都丢设置」 |

改写是**逐字**的：只动匹配到的那一行（按 `id:` 匹配、再用 `name:` 确认，绝不碰别的条目），其余内容——注释、`!!js` 表达式、别的条目——原样保留；写入先落临时文件再 `rename` 覆盖，不会留下半截 YAML。找不到 profile、没有那一行、或文件不可写都只是记一条日志，不会让插件挂载或卸载失败。

> 判断依据只有两条，都来自 DSH 自己写下的东西：profile `package.json` 的 `dsh.profile.bundles` 里还有没有本插件，以及那一行有没有 `disabled: true`。两者都没有就说明「只是重载」，这时设置原样保留，重新挂载插件配置照旧。

> 插件 0.3.0 起包名 / entry id 统一为 `dsh-proxy`；0.2.x 用的是 `id: http-proxy` / `name: dsh-http-proxy`。**历史身份的行同样会被清理**（再用 `http-proxy` 匹配一次），升级后不需要手工删老行。

## 卸载

```bash
dsh plugin --profile <profile名> remove dsh-proxy
dsh --profile <profile名>     # 重启生效
```

卸载即完全恢复原状：host 侧的 `fetch` 包装随进程结束消失；profile 补丁里那一行设置由插件自己收回（见上一节），不需要手工改文件。

## 限制

- 按域名整棵树路由，所以共享域名（如 `chatgpt.com`）下其它用途的请求也会一并被代理。
- `transport: websocket` 的流式传输、以及 amazon-bedrock 等走厂商原生 SDK 的请求不经 `fetch`，本插件管不到。
- 代理认证只能内嵌在 URL 中（`http://user:pass@host:port`）。
- 「使用系统代理」只认 Windows 注册表、macOS `scutil --proxy`、GNOME gsettings 三条路，其余桌面环境靠环境变量；系统用 PAC 脚本时读不到（脚本本身不由本插件解析）。
- 代理本身丢连接/丢并发请求时，表现为模型时好时坏。可用 `test/proxy-transport-test.mjs`（突发 + 空闲后复用）与 `test/proxy-concurrency-test.mjs` 先验证代理再决定是否启用。

## 开发

```bash
pnpm install
pnpm typecheck   # 对着真实的 DSH 0.1.7 类型声明检查
pnpm test        # 不联网：自清理（profile 补丁）+ volatile 配置契约 + 路由判定 + 系统代理解析 + 设置页渲染
pnpm build       # 生成 lib/，需一并提交
pnpm pack        # 生成 dsh-proxy-<version>.tgz，可用 file: 路径直接装
```

`pnpm build` 是双 entry：`lib/index.js`（host 半）与 `lib/profile-patch.js`（自清理，单独成文件是为了能脱离 undici / schemastery 单独测试）。`lib/client.js` 与 `lib/types/**` 也要一起提交。

`test/profile-patch-test.mjs`（profile 行的改写：删除 / 只清 `config` / 读取 `disabled` 与 bundle 选择）、`test/unload-cleanup-test.mjs`（把一个临时 profile 喂给 `apply`，再拆掉 fiber，看它到底改了什么）与 `test/system-proxy-test.mjs`（系统代理的解析：Windows 注册表输出、`ProxyServer` 两种写法、`scutil`、GSettings、环境变量兜底与平台回退）都不联网、不碰真实 profile 与注册表，可以单独跑：`node test/profile-patch-test.mjs` / `node test/unload-cleanup-test.mjs` / `node test/system-proxy-test.mjs`。
`test/proxy-*.mjs` 需要网络和一个可用代理，不参与 `pnpm test`。
客户端用例会给 `*.module.css`、`clsx`、`simple-icons`、`shiki`、`@deepseek-ai/dsh-client-store` 这些由 DSH 外壳打包提供的依赖打桩（见 `test/primitives-hook.mjs`），其余都是真代码。

## 来源与许可

基于 [elizax/dsh-http-proxy](https://github.com/elizax/dsh-http-proxy) 适配 DSH 0.1.7。MIT，见 [LICENSE](LICENSE)。
