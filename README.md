# dsh-http-proxy

给 DeepSeek Harness（DSH）加「模型请求走代理、其余请求直连」的能力，**不改任何 DSH 官方代码**。

实现方式是在 host 进程的 `globalThis.fetch` 上包一层：命中域名集合的请求走代理，其它（web 搜索、网页抓取、MCP…）照旧直连。卸载即完全恢复原状。

## 兼容性

| 插件版本 | 需要的 DSH |
| --- | --- |
| **0.2.x** | **≥ 0.1.7-rc.2** |
| 0.1.3 及更早 | 0.1.2-alpha.2 时代的插件 API，DSH 0.1.7 起已移除 |

DSH 0.1.7 重做了设置这一层：`settings.installSection`、客户端 `settingsScope` 服务、`settings.plugin.item` 插槽全部删除。0.2.x 改为 —— Host 侧把 `Config` 各字段标记 `volatile()`，靠 `loader/volatile-update` 热更新；客户端注册到设置外壳的 `settings.section` 插槽（即设置面板左侧导航），表单用官方的 `SettingsForm` / `SettingsFormModel`。

## 安装

```bash
dsh plugin --profile <profile名> add dsh-http-proxy@github:ycm50/dsh-proxy
```

`lib/` 已提交，安装时直接取用，无需构建。装完**重启一次 DSH**。

> 尚未发布到 npm。发布后可改用 `dsh plugin --profile <profile名> add dsh-http-proxy@0.2.2`。

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

### 域名条目 = 总域名

填一个域名就覆盖它的**整棵子树**，任意层级：

| 填写 | 覆盖 |
| --- | --- |
| `a.b` | `a.b`、`*.a.b`、`*.*.a.b` …… |
| `*.a.b` / `.a.b` | 同上（等价写法，`*.` 会被归一化掉） |
| `aiplatform.googleapis.com` | 另外覆盖 `us-central1-aiplatform.googleapis.com` 这类**连字符区域端点** |

`域名:端口`、`https://域名/路径` 会归一化成域名；大小写不敏感。**排除用同一套语义**：排 `a.b` 是整棵树直连，排 `api.a.b` 只把那个子域捞回来。

`proxyHosts` 留空时的自动识别范围：`api.deepseek.com`、`DEEPSEEK_BASE_URL` 指向的域名、`llm-pi-ai` 里配置的自定义网关、pi-ai 内置 provider 的默认端点。

## 限制

- 按域名整棵树路由，所以共享域名（如 `chatgpt.com`）下其它用途的请求也会一并被代理。
- `transport: websocket` 的流式传输、以及 amazon-bedrock 等走厂商原生 SDK 的请求不经 `fetch`，本插件管不到。
- 代理认证只能内嵌在 URL 中（`http://user:pass@host:port`）。
- 代理本身丢连接/丢并发请求时，表现为模型时好时坏。可用 `test/proxy-transport-test.mjs`（突发 + 空闲后复用）与 `test/proxy-concurrency-test.mjs` 先验证代理再决定是否启用。

## 开发

```bash
pnpm install
pnpm typecheck   # 对着真实的 DSH 0.1.7 类型声明检查
pnpm test        # 不联网：volatile 配置契约 + 路由判定 + 设置页渲染
pnpm build       # 生成 lib/，需一并提交
```

`test/proxy-*.mjs` 需要网络和一个可用代理，不参与 `pnpm test`。
客户端用例会给 `*.module.css`、`clsx`、`simple-icons`、`shiki`、`@deepseek-ai/dsh-client-store` 这些由 DSH 外壳打包提供的依赖打桩（见 `test/primitives-hook.mjs`），其余都是真代码。

## 来源与许可

基于 [elizax/dsh-http-proxy](https://github.com/elizax/dsh-http-proxy) 适配 DSH 0.1.7。MIT，见 [LICENSE](LICENSE)。
