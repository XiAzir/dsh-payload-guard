# dsh-payload-guard

DSH 插件：**请求体超限（HTTP 413）自愈** —— 触发后，将上下文中最老的一批图片出现位置转换为文本占位符，然后重试。占位符包含附件身份信息，并在可访问时提供本地路径。

## 解决的问题

上游网关的请求体上限通常远小于 DSH 适配器的默认图片预算：

| 层 | 限制 |
|---|---|
| `llm-pi-ai` 的 `maxRequestImageBytes` | **默认 20 MiB** |
| 实测某中转网关的真实 body 上限 | **约 10 MB**（十进制计量；实测 9.79 MB 通过、10.04 MB 返回 413） |

> 注：上表两行单位不同（MiB 是适配器的配置口径，MB 是实测字节数口径），不要混用换算。

于是图片一多，适配器的预算闸门**永远不会响**，直到上游直接拒绝。而 413 被适配器归类为 `INVALID_REQUEST`，**不在** `dsh-llm-retry` 的 `retryableCodes` 里：

```
["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"]
```

结果就是：**不重试、不降级、回合直接终止**。而上下文里那堆图片删不掉 —— 之后每次发消息都必然再撞一次墙，会话就此永久卡死。

这个问题不是本插件臆想的。同类故障在开源生态里有大量公开记录，例如 Claude Code
[#43056](https://github.com/anthropics/claude-code/issues/43056)（累积内联图片后连纯文本消息都发不出）、
[#9269](https://github.com/anthropics/claude-code/issues/9269)（413 后重启恢复仍失败）、
[#24541](https://github.com/anthropics/claude-code/issues/24541)（107 张图超媒体数量上限）。

## 插件做了什么

```
请求 ──▶ 上游超限 ──▶ payload-guard 认出「请求体过大」
                          │
                          ├─ 扫出当前 surface 里所有未 offload 的图片（最老的在前）
                          ├─ 挑出这一轮该移出的一批（默认剩余的一半）
                          ├─ 追加一持久化 image/offload 决定
                          ├─ 注入一条固定提示（提醒模型按需单张回读）
                          └─ 返回 { kind: "retry" }
                                     │
                                     ▼
                          重新 deriveMessages() → 再发一次请求
                                     │
                                     ▼
             被选中的图片渲染成「文本占位符」，
             其余图片照常发送 ──▶ 尝试重新请求；
             仍超限时继续恢复，直到成功或达到预算上限
```

模型看到的占位文本长这样（DSH 内置 `offloadedImageText()` 的输出）：

```
[image omitted to fit request image limits; "chest_crop.png" (sha256:e0fccfd8…).
 Normalized copy (read-only; may be resized or re-encoded):
 "C:\Users\...\.dsh\attachments\v1\objects\e0\e0fccfd8…" (520x360px, image/png).
 Source dimensions, format, and byte size may differ.
 Copy to a writable path ending in .png before editing.]
```

**卸载不会主动删除附件文件**，但被选中的历史图片出现位置会持续以文本占位符呈现，后续请求不会再发送该位置的图像字节。**如果**占位符包含当前执行环境可读取的本地路径，可以使用 `read_image` 按需回读；重新读取会产生**新的**图片出现位置。若无法解析路径，内置占位符只会给出附件身份，并不保证能重新读取。

## 安装

> 本插件**尚未发布到 npm**，请从 GitHub 安装。

### 方式一：从 GitHub 安装（推荐）

```bash
# 装到你 profile 的插件目录
npm install --prefix "$HOME/.dsh/profiles/web" \
  https://github.com/XiAzir/dsh-payload-guard/archive/refs/tags/v0.1.5.tar.gz
```

然后在 profile 的 `cordis.patch.yml` 里登记：

```yaml
- insert:
    - id: payload-guard
      name: dsh-payload-guard
      config:
        enabled: true
```

或直接克隆到本地任意位置，再热注入（免重启）：

```
dev_inject_plugin(dir: "<你克隆到的路径>")
```

### 方式二：直接 git clone

```bash
git clone https://github.com/XiAzir/dsh-payload-guard.git
```

```yaml
# cordis.patch.yml
- insert:
    - id: payload-guard
      name: dsh-payload-guard
      config:
        enabled: true
```

> 本插件为**通用插件**，不绑定任何工作区。

**前置依赖**：内置 `@deepseek-ai/dsh-compaction-image-offload` 必须已装载 —— 它提供
`image/offload` 事件的解释器。本插件**不抢注**该解释器；检测到它缺席时会 log 一条 warn 并
**fail-closed**（不挂监听、不写事件），而不是假装能工作。

### 版本兼容性

已在 **DSH 0.2.1-rc.2** 上通过真实 Agent Loop 集成测试。DSH 版本升级后请重跑
`npm run test:integration`（可用 `DSH_TESTKIT_VERSION=<目标版本>` 指定要验证的版本）。

本插件**不做版本号硬拦截**：版本号不能可靠代表事件语义，误停用比失效更糟。若未来 DSH
改变了 `image/offload` 的解释规则，可能出现「事件写得成功但模型看不到缩小后的请求体」
这类隐性退化 —— 届时请以集成测试结果为准，而不是靠版本号推断。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | **主开关**。`false` = 完全退回 DSH 原生行为（见下） |
| `offloadRatio` | `0.5` | 每轮移出「剩余未 offload 图片」的比例 |
| `maxOffloadPerRetry` | `12` | 单轮移出张数上限 |
| `maxRecoveriesPerTurn` | `5` | **同一回合**内最多自动恢复次数。耗尽后交回原错误 |
| `notice` | `true` | 是否注入「已发生卸载」的行为提示 |

配置值越界会被**钳制**而不是抛错。

### 总开关：`enabled`

`enabled: false` 时插件**不挂任何监听、不注册任何投影、不注入任何提示**，等价于没装：

- 413 照旧**直接失败**（`INVALID_REQUEST` 不在 `llm-retry` 的重试码里）
- 图片预算仍是适配器默认的 **20 MiB**
- 内置 `dsh-compaction-image-offload` 的既有能力**完全不受影响**

> ⚠️ 内置闸门（20 MiB）和本插件（超限救援）是**两层独立保护**。关掉本插件不会让
> 20 MiB 机制消失，它只是回到「20 MiB 闸门 + 超限直接失败」的原始状态。而问题恰恰
> 在于很多网关的真实上限远小于 20 MiB，那道内置闸门永远来不及响。

## 设计取舍

### 为什么被动触发，而不是提前估算？

仅当识别到请求体超限失败后才修改历史，尽量避免不必要的主动清理。各家网关的真实上限既不
公开也不一致（有 5 MB 的，有 10 MB 的，有几十 MB 的），提前猜阈值要么误伤、要么漏判。
需要明确的是：**错误识别仍依赖 HTTP 状态码或错误文本，不保证零误判。**

### 为什么渐进卸载，而不是一次全移出？

看起来「反正图片都在本机，全移出最省事」—— 但这是个陷阱。`image/offload` 保留附件引用，
却用**文本占位符替代 image 块**：模型必须再次调用工具才能重新看到画面。

于是全量卸载会造成**功能退化**，不只是效率降低：假设模型要比较最新的两张图 A、B，历史旧
截图导致超限。全量卸载会把 A、B 也变成占位符 → 模型 `read_image` 读回 → 这批又超限 →
再被卸载。结果是「工具读取成功，但模型始终看不到这批图」。

默认每轮尝试卸载剩余图片的一半、单轮最多 12 张，以尽量保留视觉上下文。**是否一次重试即可
通过，取决于实际请求体大小和网关限制**，不做保证。

### 为什么按回合计数，而不是按 step？

按 `${turn}/${step}` 计数时，换一个 step 就重置预算，等于对「回读 → 超限 → 再卸载」这类
**跨 step** 循环完全不设限。按回合封顶才能真正收敛。

### 为什么自己注册解释器是错的？

`image/offload` 的解释器归内置插件所有。抢注会让官方插件随后注册时抛
`projection "image/offload" is already registered`；运行期动投影表还可能让已折叠的会话
重放失败。所以检测到缺席时正确做法是**放弃**，不是顶替。

## 已知代价（诚实记录）

### 修改历史会破坏提示缓存

卸载发生在历史中间时，该位置**之后**的前缀缓存会失效（之前的部分仍可能命中）。这是修改
历史的固有代价，**即使只在失败之后触发也不是零成本** —— 失败请求之前那些成功请求可能已经
建立了很长的缓存前缀。

公开数据佐证：Claude Code
[#90716](https://github.com/anthropics/claude-code/issues/90716) 报告旧图片被逐步淘汰后，
缓存读取从约 658,681 tokens 降到 26,314 tokens。Hermes Agent
[#113517](https://github.com/NousResearch/hermes-agent/issues/113517)（修复
[PR #113953](https://github.com/NousResearch/hermes-agent/pull/113953) 已合并）记录了更精确
的账单：反复淘汰导致 707,180 / 1,145,702 tokens（约 62%）的缓存被重写。

本插件的缓解是：**只在真的失败之后才动历史**，不制造本来不需要的缓存失效。但请明确：
这是「减少不必要的失效」，不是「失败后没有代价」。

### 缓存不解决体积

Prompt cache 只省计算与费用，**请求体该有多大还是多大**（除非用文件引用或服务端有状态
接口）。缓存命中率再高，也绕不过网关上限。

### 提示是软约束

`notice` 注入的是 user-role 的运行时上下文，属于**行为引导**而非强制拦截。所以它不能替代
`maxRecoveriesPerTurn` 这道硬预算。

### 热注入场景需要重载

若本插件先加载、内置 `image-offload` 插件后加载，本插件会 fail-closed 停用。此时需**重载
payload-guard** 才能启用恢复。这是「初始化时检测一次」的固有代价，换来的是不去动运行期
投影表。

### 提示状态能从历史重建，但预算不能

恢复持久化会话、fork 分支或插件晚加载时，可从历史 `image/offload` 事件重建提示的激活
状态；实际注入仍取决于 `notice` 开关及 DSH Runtime Context 是否可用。

但 `maxRecoveriesPerTurn` 的计数是**纯内存**的：fork 出来的新会话会从零开始获得预算。
这是有意的 —— fork 是一个新分支，给它一份干净预算比继承父会话的消耗更合理。

## 明确不做的事

- **不做主动预防性清理**（每次加新图就删最老一张）。主流项目踩过这个坑：逐张淘汰会
  反复打破前缀缓存。若将来要做，应参考 Hermes Agent 的
  `image_eviction_policy.py`：阈值触发、批量卸载、保护用户上传图片。
- **不做模型自主卸载工具**。模型要调用工具卸载，前提是**先成功完成一次请求** —— 请求已经
  被拒时它根本没有机会发起工具调用。所以这只能作为正常工作阶段的优化，不能替代自动恢复。
- **不按图片大小选择（largest-first）**。该策略会让「哪几张还能看见」变得难以推理，且
  按大小跳跃删除比连续删除更难解释。

## 自检

```bash
node test/self-check.mjs              # 31 组离线自检项；部分官方 projection 交叉验证在依赖缺失时跳过
node test/dead-session-dryrun.mjs     # 用真实会话日志干跑
node test/integration/run.mjs         # 真实 Agent Loop 集成测试（自动装隔离依赖）
```

### 离线用例覆盖

- imageIndex 语义与**真实内置 projection 的交叉验证**（差一位就会标错图或让 projection 抛错）
- **裸 `INVALID_REQUEST` 绝不触发卸载**（发布前必过的安全边界；误判会造成不可逆破坏）
- **已知 HTTP 状态码否决文本匹配**：`status: 400` 不会因为消息里出现 "413" 而误判
- 与 HTTP body 无关的 `length limit exceeded` 不得误判
- 跨 step 不重置预算、新回合重置预算
- fail-closed：解释器缺席时不抢注、不挂监听
- 动态提示：未卸载时为空串、卸载后为固定文本（不含可变计数）、恢复/fork 后可从历史重建
- **历史扫描是真增量**：无新增事件时 `eventAt()` 调用次数必须为 0
- 渐进收敛轨迹、413 措辞识别与反例、无图会话、enabled 开关

### 真实 Agent Loop 集成测试

`test/integration/` 用**已发布的 npm 包**（`@deepseek-ai/dsh-agent-loop-testkit` 等）
装配真实运行时，验证离线假件证明不了的三件事：

| 场景 | 断言 |
|---|---|
| HTTP 400 | 会话日志中**没有**任何 `image/offload` 事件 |
| HTTP 413 | 真的写入 `image/offload`、真的重发请求、后续请求的图片块被官方投影标记 `offloaded` |
| 历史重建 | `offload` 事件落在真实 Session 日志里，回扫能定位到 |

装配的是真实 `Context` / `SessionStore` / 官方 `image-offload` projection / `AgentLoop`，
只有 `LlmAdapter` 是脚本化的（不访问任何上游）。

**插件仓库保持零 DSH 运行时依赖**：这些包装在仓库外的隔离临时目录
（默认 `<tmp>/dsh-payload-guard-itest`），首次运行自动安装并锁定版本。

可通过环境变量控制：

| 变量 | 作用 |
|---|---|
| `DSH_TESTKIT_DEPS` | 指定隔离依赖目录 |
| `DSH_TESTKIT_VERSION` | 锁定 DSH 版本（默认 `0.2.1-rc.2`） |
| `SKIP_INSTALL=1` | 复用已装依赖，跳过安装 |

> 版本要与你实际部署的 DSH 对齐。集成测试验证的是**发行包之间的兼容性**，
> 这比跟着源码主分支更贴近真实部署环境。

### dry-run 的证据边界

> `dead-session-dryrun.mjs` 中的图片体积统计来自附件元数据 `attachment.bytes`，
> **并非**适配器完成缩放、重新编码以及 Base64 序列化后的实际 HTTP 请求体大小。
> 干跑主要验证卸载目标的选择、官方 projection 的接受情况与收敛轨迹，
> **不代表已通过真实网关请求测试**。

## License

MIT
