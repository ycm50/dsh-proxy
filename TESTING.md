# 测试清单（dsh-proxy）

本文件是 dsh-proxy 的**全局测试列表**：说「全局测试」时按此表逐项跑，说「更新测试列表」时才改这里。日常只改动了什么就只跑对应那几项。

## 一、一条命令（推荐）

```bash
pnpm install
pnpm typecheck   # 对着真实的 DSH 类型声明检查（不联网）
pnpm test        # 下面 1-9 项，全部离线（不联网、不碰真实 profile 与注册表）
pnpm build       # 生成 lib/ 与 lib/types/**，需一并提交
```

## 二、逐项清单

| # | 命令 | 覆盖 | 需要网络 |
|---|---|---|---|
| 1 | `node test/profile-patch-test.mjs` | profile 行的改写：删除 / 只清 `config` / 读取 `disabled` 与 bundle 选择 | 否 |
| 2 | `node test/unload-cleanup-test.mjs` | 把临时 profile 喂给 `apply` 再拆掉 fiber，核对它到底改了什么、卸载是否还原 | 否 |
| 3 | `node test/host-smoke.mjs` | volatile 配置契约与默认值、稳定性契约（默认/钳制/`agentOptionsOf`/`describeStability`）、整树域名匹配、排除优先级、回环与内网豁免、URL 校验 | 否 |
| 4 | `node test/routing-dispatcher-test.mjs` | 分流落点（名单→代理、其余→加固直连）、豁免优先于名单、畸形 origin fail-open、`close/destroy` 传播、多实例安装栈与第三方替换 | 否 |
| 5 | `node test/retry-test.mjs` | 可重试失败分类、`retryOnPossibleDelivery` 开关、请求体可重放判定、abort 打断退避、`maxRetries: 0` 恒等 | 否 |
| 6 | `node test/subprocess-env-test.mjs` | 子进程环境导出（`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`/`NODE_USE_ENV_PROXY`）的写入、替换与还原 | 否 |
| 7 | `node test/wrapper-stack-test.mjs` | 多实例 wrapper 栈：重装、交错卸载、地址失效时退役与恢复 | 否 |
| 8 | `node test/system-proxy-test.mjs` | 系统代理解析：Windows 注册表、`ProxyServer` 两种写法、`scutil`、GSettings、环境变量兜底与平台回退 | 否 |
| 9 | `node --import ./test/register-hook.mjs test/client-smoke.mjs` | 客户端 bundle：装载、注入、插槽注册、设置页渲染（含稳定性分组 5 个数字 + 1 个开关）与字典完整性 | 否 |

## 三、需要网络与真实代理的（不参与 `pnpm test`）

| 命令 | 覆盖 |
|---|---|
| `node test/proxy-transport-test.mjs` | 突发请求 + 空闲后复用（连接池空闲窗口与 keepalive 的实际表现） |
| `node test/proxy-concurrency-test.mjs` | 并发下代理的丢连接/丢请求情况 |
| `node test/proxy-latency-test.mjs` | 经代理的建连与首字节延迟基线 |

跑之前确认 `10808` 端口上的代理可用；这三项用于「先验证代理，再决定是否启用」。

## 四、真机验证（改动了请求路径时必做）

在 DSH 的真实运行时里验证「接管 + 路由 + 加固 + 还原」，脚本见会话临时目录的
`hardened-verify.mjs`（要点：名单内域名指向死端口应 ECONNREFUSED、未命中应 200、
`getGlobalDispatcher()` 在卸载后身份还原、`globalThis.fetch` 不被 dispatcher 层改动）。
