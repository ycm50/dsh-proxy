# dsh-proxy

给 DeepSeek Harness（DSH）加代理能力，**不改任何 DSH 官方代码**。它要解决的问题不是「把请求塞进代理」，而是**按域名决定每条请求走哪条通道，并让反复出现的握手成本从首字里消失**：

- **一条名单，加一条轮换规则**：写进「强制走代理的域名」的域名（及其子域名）**永远走代理**；其它域名**第一次尝试直连，之后每一次尝试都换到另一条通道**——一次直连、一次代理、一次直连、一次代理——所以一条通道整条坏掉时，另一条会把它扛过去，而不是让整轮请求全灭。
- **每次尝试都记录**：哪条通道、第几次尝试、成功还是失败、失败码、耗时，逐条写进日志（见「诊断」）。「哪条通道坏了」是记录下来的事实，不靠猜。
- **成功也换**：轮换是轮转，不是判决——上一次成功不代表下一次还走这条。两条通道因此都被持续使用与检验；代价是大约一半的请求会经代理（比纯直连多 0.2–1 秒，隧道复用时更少）。
- **回环与内网/LAN 段是内置豁免**，任何配置都改不动：本地服务永远不出机器。
- **连接复用 120 秒**：一次对话的多轮消息落在同一条（代理）隧道上，握手不再出现在每一轮的首字里。
- **逐请求计时（可选）**：`DSH_PROXY_DEBUG=1` 打开后，每次请求都记下走的是哪条通道、连接是新建还是复用、等到响应头与首个 SSE 分片各花了多久。

打开「插件安装/更新也走代理」还能让 pnpm / git 这类子进程也走代理。代理地址可以手填，也可以在设置页勾一下「使用系统代理」，直接读本机（Windows / macOS / Linux）的代理设置。## 为什么（实测的账）

这台机器上的实测数字决定了下面每一个默认值：

| 观察 | 实测 | 插件的对策 |
| --- | --- | --- |
| 新建一条代理隧道 | **1.3–1.9 s**（大头是 `CONNECT` 隧道里那次 TLS 握手） | 连接复用窗口 **120 s**：同一会话第 2 轮起降到 **0.2–0.3 s** |
| 直连抖动 | 中位 **1.0 s**，但约每三次就有一次飙到 **3.7–5.0 s** | 重试轮换：直连失败就换代理重试，代理失败再换回直连，一条通道坏掉不再吃掉整轮请求 |
| 能连但被限速 | 某镜像直连 **30 s**、经代理 **2 s** | 强制名单：钉死走代理，不试直连 |
| 首字构成 | 握手 + 边缘/服务端排队 + 模型思考 | 只回收前两项；第三项不是网络问题，观测层把三者分开 |

实现方式有两层：host 进程里装一个**进程级 undici dispatcher**（按 hostname 分流；覆盖那些早就捕获了 `fetch`、或直接用 undici API 的调用方），再包一层 `globalThis.fetch`（覆盖自带 dispatcher 的调用方）。两条通道——代理通道与直连通道——都由插件自己构建，共用同一套加固选项：建连上限、TCP keepalive、**120 秒的连接复用窗口**、连接级重试。卸载即完全恢复原状：dispatcher 与 `fetch` 都还原成安装前的那一个，连接池优雅关闭（不打断在途请求），profile 里那一行设置也会被插件自己收回（见「清空即自清理」）。

## 兼容性

| 插件版本 | 需要的 DSH |
| --- | --- |
| **0.7.0** | **≥ 0.2.0-rc.1**（策略换成「强制名单 + 重试轮换」：**去掉了「自动选路的域名」「排除域名」和「通道选择」三个设置组**，未列出的域名改为第一次直连、失败即换通道重试，并逐次记录；代理地址、系统代理、子进程导出、超时与重试参数不变） |
| **0.6.1** | **≥ 0.2.0-rc.1**（新增「强制走代理的域名」：命中即钉死走代理，不测量、不回落，用于「能直连但被限速」的站点；设置页拆成连接 / 域名名单 / 通道选择 / 请求稳定性四组） |
| **0.6.0** | **≥ 0.2.0-rc.1**（名单内的域名改为「直连优先、变慢走代理」：新增「通道选择」三个设置项；直连失败且确定未送达时，同一请求就地改走代理重发一次；`route=auto` 是新的默认值，关掉它即恢复 0.5.x 的静态规则） |
| **0.5.1** | **≥ 0.2.0-rc.1**（连接复用窗口 10 s → 120 s，一条会话不再每条消息重打一次隧道；`connectTimeoutMs` 现在真的作用到代理 `CONNECT` 隧道里的 TLS 握手，此前 `ProxyAgent` 忽略它、仍是 10 s 默认；happy-eyeballs 探测间隔 2500 ms → Node 默认 250 ms；新增 `DSH_PROXY_DEBUG` 请求计时，见「诊断」） |
| **0.5.0** | **≥ 0.2.0-rc.1**（接管扩到进程级 undici dispatcher；两条通道加固；未列出的域名不再回落官方栈；新增「请求稳定性」参数；回环与内网段豁免） |
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

**设置面板 → 左侧导航「HTTP 代理」**，填好点保存，下一次请求即生效，无需重启。页面分三组：**连接**（代理地址 / 使用系统代理 / 插件安装也走代理）、**域名名单**（强制走代理的域名）、**请求稳定性**（超时与重试）。

| 字段 | 说明 |
| --- | --- |
| 代理地址 | `http` / `https` / `socks4` / `socks4a` / `socks5` / `socks5h`。**留空 = 插件不生效** |
| 使用系统代理 | 勾选后**立即**读取本机代理设置并填入「代理地址」；勾选期间优先使用系统代理（见下） |
| 插件安装/更新也走代理 | 默认关闭。打开后把代理写进**子进程环境变量**，让 `dsh plugin` 调用 pnpm / git 安装或更新插件时也走代理；**仅在「代理地址」是 http/https 时生效**（见「限制」） |
| 记录尝试日志到文件 | **默认关闭**。打开后，每次尝试与每次挂载/重建/卸载都追加到 `<DSH_HOME>/dsh-proxy.log`（见「诊断」）；**下一次请求即生效，不用重启**。需要抓问题时打开，抓完关掉 |
| 强制走代理的域名 | **唯一的名单**：命中的域名及其子域名**永远走代理**，不试直连、不参与轮换、不受任何失败影响。适合「直连能通但被限速到没有意义」的站点（实测某镜像直连 30 秒、经代理 2 秒就是这类）。**留空 = 没有钉死的域名**，所有域名都走下面的轮换规则。逗号分隔，支持域名 / 域名:端口 / URL / `.域名` 后缀 |
| 建连超时（毫秒） | 默认 `60000`。TCP 建连、以及代理 `CONNECT` 隧道建立（含隧道内那次 TLS 握手）的上限。**别低于 30000**：本机实测代理握手最慢 10.5 秒，undici 默认的 10 秒会把它变成 `UND_ERR_CONNECT_TIMEOUT`。0.5.1 起这个值经 `proxyTls` / `requestTls` 真正作用到隧道上（此前 `ProxyAgent` 忽略它） |
| 等待响应头超时（毫秒） | 默认 `300000`，`0` = 不限制 |
| 流空闲超时（毫秒） | 默认 `0`（不限制）：流式传输中两个分片之间的间隔不设上限，慢模型不会被本插件掐断（DSH 自己另有流看门狗） |
| 连接重试次数 | 默认 `3`，`0` = 关闭。**它同时是轮换的次数**：3 表示一次请求最多 4 次尝试（第 1 次直连，之后每次换通道）。只重试**连接级**失败，且仅当请求体可重放；指数退避 + 抖动，可用「停止」立刻打断 |
| 重试退避基数（毫秒） | 默认 `400`，每次翻倍 |
| 「可能已送达」也重试 | 默认开。对「请求可能已到达服务端之后连接被重置」也重试；若重复一次请求会产生费用，可关掉（关掉后只重试确定未送达的失败） |

### 重试策略：一次直连、一次代理

没有「自动选路的域名」也没有「排除域名」了：**除了强制名单里的域名，其它域名都走同一条规则**。

| 情形 | 走哪条通道 |
| --- | --- |
| 强制名单命中 | **代理**，每次都代理，失败也在代理上重试，不换通道 |
| 回环 / 内网 / LAN（`localhost`、`127.0.0.0/8`、`::1`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`100.64/10`、IPv6 `fc00::/7` 与 `fe80::/10`、`.local` / `.lan` / `.internal` / `.home.arpa`） | **直连**，永远不出机器，也不换通道 |
| 其它域名 | **第 1 次尝试直连**，之后**每一次尝试**都换到另一条通道（成功也换）；一直交替到用满「连接重试次数」 |

规则细节：

- **成功也换**：一次尝试结束就换通道，不因为「上一次成功了」而留在原地。所以一个健康的域名也是一次直连、一次代理地轮换——这是刻意的：两条通道都要被持续使用，才不会出现「一直走直连，直连坏掉时才知道」。
- **轮换跟着域名走**：某个域名上一次失败在代理上，它**下一条请求**就从代理开始；两条通道都坏就一直交替。所以「一次直连、一次代理」既是同一条请求内部的重试顺序，也是这个域名后续请求的起点。
- **两层拦截都参与轮换**：包 `globalThis.fetch` 的那一层（自带 dispatcher 的调用方）和进程级 dispatcher 那一层（早就捕获了 `fetch` 的调用方，例如 pi-ai）都会在每次尝试后推动同一个游标——两层只推动、不各自记账，所以同一个域名不会因为走了哪一层而有两套状态。
- **换通道 ≠ 重试**：换通道是每一次尝试都发生的事；「重试」仍然只针对连接级失败——请求体不可重放、调用方按了「停止」、以及 HTTP 状态码（那是响应，不是传输失败）都不重试。默认连「可能已送达」的重置（`ECONNRESET` 等）也重试——关掉「可能已送达也重试」就只重试确定没送出去的那一类。
- **每次尝试都记录**：`hostname attempt 2/4 via proxy -> failed ECONNRESET in 31ms (retrying on the other channel)`。日志在哪里看，见「诊断」。
- 想回到「某站点一律走代理」，就写进**强制名单**；想让它「绝不走代理」，目前只有回环/内网那套内置豁免——这一版刻意不再提供「排除域名」。

也可以只设环境变量，等价于「代理地址」（走不走代理仍由强制名单与轮换规则决定）：

```powershell
$env:DSH_HTTP_PROXY = 'socks5://127.0.0.1:7890'
```

> 环境变量名保持 `DSH_HTTP_PROXY`，它不属于包名 / entry id，0.3.0 的更名没有动它（DSH 自带的进程级代理读的是 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`，与本插件互不影响）。
### 连接复用：首字延迟里最容易省掉的那一段

插件把连接池的空闲窗口定在 **120 秒**（`keepAliveTimeout`，见 `src/stability.ts` 的 `POOLED_IDLE_WINDOW_MS`），而不是 undici 自己那个 4 秒默认。原因是实测的账：本机经本地代理**新建一条隧道要 1.3–1.9 秒**（其中大头是 `CONNECT` 隧道里那次 TLS 握手），而复用一条已有隧道只要 0.2–0.3 秒；一次对话的发消息节奏是每 10–60 秒一轮。窗口定在 4 秒（或旧版的 10 秒）就等于**每条消息都重新握手一次**，那段时间和模型思考捆在一起，看起来就是“首字变慢”。窗口拉到 120 秒之后，同一条会话的第二轮起直接复用隧道。

同时修掉的一处是参数的落点：`undici` 的 `ProxyAgent` **只读 `proxyTls` / `requestTls` 两个对象**，顶层 `connect` 会被隧道拨号函数整个覆盖。所以「建连超时」这一项目前对代理通道是靠这两个对象生效的（`connectorOptionsOf` 同时喂给它们），否则隧道里的 TLS 仍是 undici 的 10 秒默认——README 早期记录的「代理握手 10.5 秒被判超时」正是这个默认值造成的。

想自己验证，用 `test/latency-bench.mjs`（需要网络和代理，不参与 `pnpm test`）：

```powershell
node test/latency-bench.mjs --url https://api.opencode.ai/v1/models --proxy http://127.0.0.1:10808 --runs 3 --gap 15000
```

它会并排打印 `native` / `direct` / `proxy` 三条通道每一次请求的 `conn`（fresh / reused）、`headers`、`first`（SSE 才有）与总耗时。`--gap 15000` 就是模拟“想了一会儿再发下一条”：第二轮仍是 `reused`、`headers` 掉到几百毫秒，说明窗口生效。

### 诊断：看清每次请求的耗时

默认关闭。把环境变量打开后，host 侧会给**每一次**模型/网络请求记一行，并每 20 次给一次汇总：

```powershell
$env:DSH_PROXY_DEBUG = '1'   # 0 / false / off / no 都等于关闭
```

```
dsh-proxy: POST https://api.opencode.ai via proxy (new connection) -> 200 headers=1642ms first=2231ms
dsh-proxy: 20 recent requests — proxy 12x (fresh 9) headers p50=1500ms p95=3200ms first p50=2100ms p95=4800ms · direct 8x (fresh 3) ...
```

> 它只在插件**挂载时**读一次，所以要写进启动 DSH 之前的环境里（用户级环境变量，或从设过这个变量的 shell 里启动 DSH）；改完不重启不会生效。

#### 尝试记录：开关 + `~/.dsh/dsh-proxy.log`

轮换的每一次尝试本来就走 host 日志，但桌面版的 host 日志没有落盘的地方，出问题时看不到。所以设置页「连接」组里有一个**开关**：**默认关闭**，需要抓的时候打开，同一次运行的下一个请求就会被记下来（字段是 volatile，不用重启）；抓完关掉即可。打开后写入（超过 4 MB 滚动成 `.1`）：

```
dsh-proxy: record on — appending to C:\Users\you\.dsh\dsh-proxy.log
dsh-proxy: routing generation installed — proxy=http://127.0.0.1:10808 forced=2 retry=3x400ms rotate=route=rotate (…)
dsh-proxy: api.opencode.ai attempt 1/4 via direct -> failed ECONNREFUSED in 31ms (next attempt takes the other channel)
dsh-proxy: api.opencode.ai attempt 2/4 via proxy -> ok in 412ms (next attempt takes the other channel)
dsh-proxy: api.opencode.ai via direct (dispatcher) -> ok in 388ms (next via proxy)
dsh-proxy: routing deactivated (the wrapper and the dispatcher are being retired)
```

位置是 `<DSH_HOME>/dsh-proxy.log`（默认 `~/.dsh/dsh-proxy.log`）。`DSH_PROXY_LOG` 可以指定别的路径，**并且它本身就是开关**——设了非空值就等于打开，适合抓"还没走到设置页"的启动阶段（挂载时读一次）。

**它记的是"请求有没有走到本插件"这个事实**：挂载 / 重建 / 卸载各一行，每次尝试一行（通道、第几次、成功或失败、失败码、耗时）。如果模型请求失败时这里**一行都没有**，那说明那条请求根本没经过本插件的 fetch / dispatcher 两层——问题不在代理路径上，而在更上层（SDK / 适配器自己发起的连接）。写不进去只吞掉那一行，绝不影响请求。

几个刻意的取舍：

- `first` 是**首个 SSE 分片**的时间，也就是真正的“首字”；它靠 `response.clone()` 旁路读取，你拿到的那个 `Response` 原样不动（status / headers / `url` / body 都是同一个对象），读完第一片立刻取消克隆分支，不会把整个流缓存第二份。
- `fresh` 来自 undici 自己的 `undici:client:beforeConnect` 诊断通道，不是猜连接池内部状态。
- 计时器挂在**重试层里面**：一次尝试一个样本，所以“断线重拨”会显示成两个样本，而不是一个虚高的样本。
- 关掉开关时，请求路径上没有任何计时器、环形缓冲与诊断订阅。

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
| 代理地址为空、三条域名名单全为空、「使用系统代理」和「插件安装/更新也走代理」都没勾选、选路与稳定性都是默认值 | 运行时就把这一行收掉——这份设置什么都没携带。两个开关里只要有一个是勾上的，行就保留：`false` 是默认值，存下来的 `true` 本身就是这份设置携带的信息 |
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
- 插件**自带一份 undici**，它的 `Request` 类与平台 `fetch` 给出的 `Request` **不是同一个类**。所以调用方传进来的 `Request` 会被拆开（URL / method / headers / body / signal 等重组成一个普通 init）再交给自带 undici；不这么做，undici 会把它 `String()` 成 `"[object Request]"`，然后以 `ERR_INVALID_URL` **在毫秒内、不发任何字节地失败**（两条通道都一样，看起来像"怎么都连不上"）。
- 轮换意味着**未列出的域名也可能出现在代理日志里**：只要它直连失败过一次，下一次尝试就会走代理。不想让某个域名有这个可能，就把它钉在直连侧——这一版没有这个开关，唯一的内置保证是回环与内网段永远直连。
- **子进程只看 `NO_PROXY`，看不到强制名单**：pnpm / git 拿到的是全局的 `HTTP_PROXY` / `HTTPS_PROXY`，`NO_PROXY` 里只有回环和你机器原有的条目。也就是说子进程里的域名一律走代理——包括强制名单里的那些（那正是「插件安装/更新也走代理」的意义）。
- `transport: websocket` 的流式传输、以及 amazon-bedrock 等走厂商原生 SDK 的请求不经 `fetch`，本插件管不到。
- 代理认证只能内嵌在 URL 中（`http://user:pass@host:port`）。
- 「插件安装/更新也走代理」只在「代理地址」是 `http` / `https` 时注入子进程环境变量；`socks4` / `socks4a` / `socks5` / `socks5h` 这类 SOCKS 地址，以及任何 Node 无法解析的值，**都不会注入**——子进程拿到一个自己解析不了的代理地址会**直接启动失败**（实测：`NODE_USE_ENV_PROXY=1` 配 `notaurl` 或 `ftp://…` 时 Node 子进程 exit 1；`socks5://…` 则是被静默忽略、等于直连）。想让插件安装也走代理，请把「代理地址」换成同一个代理的 http/https 入口。
- 「使用系统代理」只认 Windows 注册表、macOS `scutil --proxy`、GNOME gsettings 三条路，其余桌面环境靠环境变量；系统用 PAC 脚本时读不到（脚本本身不由本插件解析）。
- 代理本身丢连接/丢并发请求时，表现为模型时好时坏。可用 `test/proxy-transport-test.mjs`（突发 + 空闲后复用）与 `test/proxy-concurrency-test.mjs` 先验证代理再决定是否启用。

## 开发

```bash
pnpm install
pnpm typecheck   # 对着真实的 DSH 类型声明检查
pnpm test        # 不联网：自清理（profile 补丁）+ volatile 配置契约 + 稳定性契约 + 通道轮换
                 #        + 路由判定与豁免 + 连接级重试 + 多实例装卸 + 请求计时 + 系统代理解析 + 设置页渲染
pnpm build       # 生成 lib/，需一并提交
pnpm pack        # 生成 dsh-proxy-<version>.tgz，可用 file: 路径直接装
```

测试清单见 [TESTING.md](TESTING.md)：说「全局测试」时按那份列表逐项跑，说「更新测试列表」时才改它；日常只改了什么就只跑对应那几项。

版本库约定（对应 `.gitignore`）：`lib/**` —— 包括 `lib/index.js`、`lib/profile-patch.js`、`lib/client.js`、`lib/client.js.map` 与 `lib/types/**` —— **故意提交**，这样从 GitHub 或 tarball 安装都不需要构建步骤；`node_modules/`、`dist/`、`build/`、`out/`、`coverage/`、`*.tsbuildinfo`、`*.tgz`、`*.log`、`*.prune.tmp`、`.env*`、编辑器目录（`.vscode/`、`.idea/`）与 `.pnpm-store/` 都在忽略之列。**改了源码必须 `pnpm build` 并把 `lib/**` 一起提交**，否则装进 DSH 的还是旧代码（本次 0.7.0 就是源码与 `lib/` 同一次提交）。

`pnpm build` 是双 entry：`lib/index.js`（host 半）与 `lib/profile-patch.js`（自清理，单独成文件是为了能脱离 undici / schemastery 单独测试）。`lib/client.js` 与 `lib/types/**` 也要一起提交。

host 半的模块划分：`index.ts`（生命周期与两层装卸）、`dispatch.ts`（进程级 dispatcher：按 hostname 分流、豁免判定、多实例安装栈）、`proxy.ts`（两条通道的构建，以及**轮换重试的请求路径**：第 1 次直连、失败换通道、每次尝试都上报）、`routing.ts`（每个域名的通道游标：失败翻面、成功不动）、`stability.ts`（超时/重试参数、范围钳制、undici 选项与两条通道共用的 connector 形状）、`retry.ts`（哪些失败可重试、可重放判定、退避与可打断的等待）、`observe.ts`（`DSH_PROXY_DEBUG` 下的每请求计时与复用归属）、`config.ts`（volatile 配置与防御式读取）、`hosts.ts`（域名整树匹配与回环/内网豁免）、`system-proxy.ts` 与 `profile-patch.ts` 各司其职。

`test/profile-patch-test.mjs`（profile 行的改写：删除 / 只清 `config` / 读取 `disabled` 与 bundle 选择）、`test/unload-cleanup-test.mjs`（把一个临时 profile 喂给 `apply`，再拆掉 fiber，看它到底改了什么）与 `test/system-proxy-test.mjs`（系统代理的解析：Windows 注册表输出、`ProxyServer` 两种写法、`scutil`、GSettings、环境变量兜底与平台回退）都不联网、不碰真实 profile 与注册表，可以单独跑：`node test/profile-patch-test.mjs` / `node test/unload-cleanup-test.mjs` / `node test/system-proxy-test.mjs`。
`test/routing-dispatcher-test.mjs`（分流与豁免：强制名单命中→代理通道、未命中→加固直连、回环与内网段（`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`100.64/10`、`fc00::/7`、`fe80::/10`、`.local` 等）永不代理、畸形 origin 一律 fail-open 走直连、`close` / `destroy` 是否收掉两条通道、多实例安装栈与「第三方替换后我们不回收」）与 `test/retry-test.mjs`（哪些失败可重试、`retryOnPossibleDelivery` 的开关语义、不可重放的请求体只发一次、调用方 abort 立刻打断退避、`maxRetries: 0` 时函数恒等）都不联网、不需要代理。
`test/routing-fetch-test.mjs`（轮换重试：第 1 次必直连、失败后逐次换通道、成功即停、强制名单不轮换、回环/内网永不离开机器、重试门槛（不可重放 / 已取消 / HTTP 状态 / 未知错误码）与每次尝试的记录）与
`test/routing-selector-test.mjs`（通道轮换：未动过的域名从直连开始、失败才翻面、成功原地不动、游标按域名各记各的、连续失败读作直连/代理交替、`reset` 全部回到直连）与 `test/observe-test.mjs`（请求计时：开关语义、`Response` 原样返回、SSE 首片归属、新建/复用归属、汇总与 `dispose`）同样不联网。
`test/proxy-*.mjs` 与 `test/latency-bench.mjs` 需要网络和一个可用代理，不参与 `pnpm test`。
客户端用例会给 `*.module.css`、`clsx`、`simple-icons`、`shiki`、`@deepseek-ai/dsh-client-store` 这些由 DSH 外壳打包提供的依赖打桩（见 `test/primitives-hook.mjs`），其余都是真代码。

## 来源与许可

基于 [elizax/dsh-http-proxy](https://github.com/elizax/dsh-http-proxy) 适配 DSH 0.1.7。MIT，见 [LICENSE](LICENSE)。
