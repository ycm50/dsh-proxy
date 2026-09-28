# dsh-proxy

给 DeepSeek Harness（DSH）加「模型请求走代理、其余请求直连」的能力，**不改任何 DSH 官方代码**。

实现方式是在 host 进程的 `globalThis.fetch` 上包一层：命中域名集合的请求走代理，其它（web 搜索、网页抓取、MCP…）照旧直连。卸载即完全恢复原状——profile 里那一行设置也会被插件自己收回（见「清空即自清理」）。

## 兼容性

| 插件版本 | 需要的 DSH |
| --- | --- |
| **0.3.x** | **≥ 0.1.7-rc.2**（包名 / entry id 均为 `dsh-proxy`） |
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
| 只代理这些域名 | **留空 = 自动识别所有模型域名**；填写 = 只代理这些域名 |
| 排除域名 | 永远直连，优先于上一项 |

也可以只设环境变量，等价于「代理地址」（域名过滤仍走默认自动识别）：

```powershell
$env:DSH_HTTP_PROXY = 'socks5://127.0.0.1:7890'
```

> 环境变量名保持 `DSH_HTTP_PROXY`，它不属于包名 / entry id，0.3.0 的更名没有动它（DSH 自带的进程级代理读的是 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`，与本插件互不影响）。

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

这一行**不会**随「关掉插件 / 从 bundles 移除 / 卸载」一起消失——DSH 只摘掉 bundle，行本身留着，于是 profile 看起来「还原不回去」。所以插件自己把它收回去。下面任一情况成立时，插件会把这一行从 profile 里删掉：

- **代理地址为空**，并且「只代理这些域名」「排除域名」**也都是空的**：这份设置什么都没携带，留着只是残渣；
- **插件被停用 / 卸载（fiber 卸载）时**，设置同样为空。

删除是**逐字**的：只摘掉匹配到的那一行（按 `id:` 匹配、再用 `name:` 确认，绝不碰别的条目），其余内容——注释、`!!js` 表达式、别的条目——原样保留；写入先落临时文件再 `rename` 覆盖，不会留下半截 YAML。找不到 profile、没有那一行、或文件不可写都只是记一条日志，不会让插件挂载失败。

> 还在用的设置**不会**被抹掉：只要 `proxy` 或两个域名列表里还有值，那一行就留着，重新挂载插件时配置照旧。反过来说，如果你的流程是「先关插件再看 profile」，请先把代理地址和两个域名列表清空——那一步就把行删掉了，之后怎么关都干净。

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
- 代理本身丢连接/丢并发请求时，表现为模型时好时坏。可用 `test/proxy-transport-test.mjs`（突发 + 空闲后复用）与 `test/proxy-concurrency-test.mjs` 先验证代理再决定是否启用。

## 开发

```bash
pnpm install
pnpm typecheck   # 对着真实的 DSH 0.1.7 类型声明检查
pnpm test        # 不联网：自清理（profile 补丁）+ volatile 配置契约 + 路由判定 + 设置页渲染
pnpm build       # 生成 lib/，需一并提交
pnpm pack        # 生成 dsh-proxy-<version>.tgz，可用 file: 路径直接装
```

`pnpm build` 是双 entry：`lib/index.js`（host 半）与 `lib/profile-patch.js`（自清理，单独成文件是为了能脱离 undici / schemastery 单独测试）。`lib/client.js` 与 `lib/types/**` 也要一起提交。

`test/profile-patch-test.mjs` 不依赖任何第三方包，可以单独跑：`node test/profile-patch-test.mjs`。
`test/proxy-*.mjs` 需要网络和一个可用代理，不参与 `pnpm test`。
客户端用例会给 `*.module.css`、`clsx`、`simple-icons`、`shiki`、`@deepseek-ai/dsh-client-store` 这些由 DSH 外壳打包提供的依赖打桩（见 `test/primitives-hook.mjs`），其余都是真代码。

## 来源与许可

基于 [elizax/dsh-http-proxy](https://github.com/elizax/dsh-http-proxy) 适配 DSH 0.1.7。MIT，见 [LICENSE](LICENSE)。
