# 测试清单（dsh-proxy）

本文件是 dsh-proxy 的**全局测试列表**：说「全局测试」时按此表逐项跑，说「更新测试列表」时才改这里。日常只改动了什么就只跑对应那几项。

## 一、一条命令（推荐）

```bash
pnpm install
pnpm typecheck   # 对着真实的 DSH 类型声明检查（不联网）
pnpm test        # 下面 1-12 项，全部离线（不联网、不碰真实 profile 与注册表）
pnpm build       # 生成 lib/ 与 lib/types/**，需一并提交
```

## 二、逐项清单

| # | 命令 | 覆盖 | 需要网络 |
|---|---|---|---|
| 1 | `node test/profile-patch-test.mjs` | profile 行的改写：删除 / 只清 `config` / 读取 `disabled` 与 bundle 选择 | 否 |
| 2 | `node test/unload-cleanup-test.mjs` | 把临时 profile 喂给 `apply` 再拆掉 fiber，核对它到底改了什么、卸载是否还原；`DSH_PROXY_DEBUG` 的接线与否决 | 否 |
| 3 | `node test/host-smoke.mjs` | volatile 配置契约与默认值、稳定性契约（默认/钳制/`agentOptionsOf`/`describeStability`）、选路契约（默认值/钳制/`describeRoute`）、强制名单的优先级（排除 › 强制 › 自动；回环与内网永不强制）、整树域名匹配、排除优先级、回环与内网豁免、URL 校验 | 否 |
| 4 | `node test/routing-dispatcher-test.mjs` | 分流落点（名单→代理、其余→加固直连）、豁免优先于名单、畸形 origin fail-open、`close/destroy` 传播、多实例安装栈与第三方替换 | 否 |
| 5 | `node test/retry-test.mjs` | 可重试失败分类、`retryOnPossibleDelivery` 开关、请求体可重放判定、abort 打断退避、`maxRetries: 0` 恒等 | 否 |
| 6 | `node test/subprocess-env-test.mjs` | 子进程环境导出（`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`/`NODE_USE_ENV_PROXY`）的写入、替换与还原 | 否 |
| 7 | `node test/wrapper-stack-test.mjs` | 多实例 wrapper 栈：重装、交错卸载、地址失效时退役与恢复 | 否 |
| 8 | `node test/system-proxy-test.mjs` | 系统代理解析：Windows 注册表、`ProxyServer` 两种写法、`scutil`、GSettings、环境变量兜底与平台回退 | 否 |
| 9 | `node test/observe-test.mjs` | 请求计时：开关语义、每请求字段、`response` 原样返回、SSE 首片归属、新建/复用连接的归属、按通道汇总、环形缓冲与 `dispose` | 否 |
| 10 | `node test/routing-selector-test.mjs` | 自动选路：未列出域名永不动、关掉开关恢复静态规则、「连续两次偏慢 / 一次连接失败」才切代理、冷却按次翻倍并封顶、探测健康即回切、`decide` 无副作用、只往代理方向切、强制名单钉死且不受自动开关影响、三项设置的钳制 | 否 |
| 11 | `node test/routing-fetch-test.mjs` | 选路落点与兜底边界：名单内先走一次性直连、未命中走带重试直连、关掉开关即一律代理；「确定未送达」才跨通道重发，`ECONNRESET` / 非可重放请求体 / 已 abort / HTTP 状态码一律不改走、只往代理方向切、慢两次后下一条请求直接走代理、强制名单命中即走代理且代理失败不回落到直连 | 否 |
| 12 | `node --import ./test/register-hook.mjs test/client-smoke.mjs` | 客户端 bundle：装载、注入、插槽注册、设置页渲染（四组：连接 / 域名名单含强制名单输入框 / 通道选择 1 开关 + 2 数字 / 稳定性 5 数字 + 1 开关）与字典完整性 | 否 |

## 三、需要网络与真实代理的（不参与 `pnpm test`）

| 命令 | 覆盖 |
|---|---|
| `node test/proxy-transport-test.mjs` | 突发请求 + 空闲后复用（连接池空闲窗口与 keepalive 的实际表现） |
| `node test/proxy-concurrency-test.mjs` | 并发下代理的丢连接/丢请求情况 |
| `node test/latency-bench.mjs --url <URL> --proxy <代理> --runs 3 --gap 15000` | 三条通道（native / direct / proxy）逐次 `fresh|reused`、`headers`、SSE `first` 与总耗时；`--gap` 模拟对话间隔，用来验证「空闲后仍复用」 |

跑之前确认 `10808` 端口上的代理可用；这几项用于「先验证代理与首字预算，再决定是否启用」。

`latency-bench.mjs` 的判据：同一通道第 2 次起应为 `reused`，`headers` 落到几百毫秒；若 `--gap 15000` 下第 2 次仍是 `fresh`，说明连接复用窗口没生效。

## 四、真机验证（改动了请求路径时必做）

在 DSH 的真实运行时里验证「接管 + 路由 + 加固 + 还原」，脚本见会话临时目录的
`hardened-verify.mjs`（要点：名单内域名指向死端口应 ECONNREFUSED、未命中应 200、
`getGlobalDispatcher()` 在卸载后身份还原、`globalThis.fetch` 不被 dispatcher 层改动）。
