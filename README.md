# dsh-payload-guard

DSH 插件：**`413 Request payload is too large` 自愈** —— 触发后把上下文里最老的图片替换成本地绝对路径占位文本，然后自动重试。

## 解决的问题

上游网关的请求体上限通常远小于 DSH 适配器的默认图片预算：

| 层 | 限制 |
|---|---|
| `llm-pi-ai` 的 `maxRequestImageBytes` | **默认 20 MiB** |
| 实测某中转网关的真实 body 上限 | **不到 5 MiB** |

于是图片一多，适配器的预算闸门**永远不会响**，直到上游直接回 413。而 413 被适配器归类为 `INVALID_REQUEST`，**不在** `dsh-llm-retry` 的 `retryableCodes` 里：

```
["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"]
```

结果就是：**不重试、不降级、回合直接终止**。而上下文里那堆图片删不掉 —— 之后每次发消息都必然再吃一次 413，会话就此永久卡死（俗称「死档」）。

## 插件做了什么

```
请求 ──▶ 上游 413 ──▶ payload-guard 认出 413
                          │
                          ├─ 扫出当前 surface 里所有未 offload 的图片（最老的在前）
                          ├─ 挑出这一轮该移出的一批（默认剩余的一半）
                          ├─ 追加一持久化 image/offload 决定
                          └─ 返回 { kind: "retry" }
                                     │
                                     ▼
                          重新 deriveMessages() → 再发一次请求
                                     │
                                     ▼
                   被选中的图片已渲染成「本地路径占位文本」
                   其余图片照常发送 ──▶ 请求通过
```

模型看到的占位文本长这样（DSH 内置 `offloadedImageText()` 的输出）：

```
[image omitted to fit request image limits; "chest_crop.png" (sha256:e0fccfd8…).
 Normalized copy (read-only; may be resized or re-encoded):
 "C:\Users\...\.dsh\attachments\v1\objects\e0\e0fccfd8…" (520x360px, image/png).
 Source dimensions, format, and byte size may differ.
 Copy to a writable path ending in .png before editing.]
```

**图片没有丢失**，只是这一轮不发送字节流。模型想再看，用 `read_image` 读那个绝对路径即可 —— `read_image` 支持无扩展名文件（按 magic bytes 嗅探格式），不必先复制成 `.png`。

## 安装

```yaml
# 加到你 profile 的 cordis.patch.yml（或用 dev_inject_plugin 直接注入）
- insert:
    - id: payload-guard
      name: dsh-payload-guard
      config:
        enabled: true          # 关掉就写 false，回到 DSH 原生 413 行为
        offloadRatio: 0.5
        maxOffloadPerRetry: 12
        maxRetriesPerStep: 6
```

或直接用 super-injector 热注入（免重启）：

```
dev_inject_plugin(dir: "E:/dsh-plugins/dsh-payload-guard")
```

> 本插件为**通用插件**，不绑定任何工作区；放在 `E:/dsh-plugins/` 下，任何 profile 都可用。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | **主开关**。`false` = 完全退回 DSH 原生行为（见下） |
| `offloadRatio` | `0.5` | 每轮移出「剩余未 offload 图片」的比例。反复 413 时逐轮收敛 |
| `maxOffloadPerRetry` | `12` | 单轮移出张数上限，防止一次把图片全清空 |
| `maxRetriesPerStep` | `6` | 同一步内最多自愈重试次数。耗尽后把原错误交回，行为与没装插件时一致 |

配置值越界会被**钳制**而不是抛错，插件不会因为写错一个数字就装不上。

### 总开关：`enabled`

```yaml
- id: payload-guard
  name: dsh-payload-guard
  config:
    enabled: false     # 关掉 413 救援，回到默认
```

`enabled: false` 时插件**不挂任何监听、不注册任何投影**，等价于没装：

- 413 照旧**直接失败**（`INVALID_REQUEST` 不在 `llm-retry` 的重试码里）
- 图片预算仍是适配器默认的 **20 MiB**
- 内置 `dsh-compaction-image-offload` 的既有能力**完全不受影响**

> ⚠️ 注意这两者不是同一个东西。内置闸门（20 MiB）和本插件（413 救援）是
> **两层独立保护**：关掉本插件不会让 20 MiB 机制消失，它只是回到「20 MiB 闸门
> + 413 直接失败」的原始状态。而问题恰恰在于很多网关的真实上限远小于 20 MiB，
> 所以那道内置闸门永远来不及响。

## 设计取舍

**为什么被动触发，而不是提前估算？**
各家网关的真实上限既无文档也不一致（有的 5 MB，有的 50 MB），提前猜阈值要么误伤（把还能发的图推掉）、要么漏判（照样 413）。只在真的 413 之后动手，零误伤。

**为什么复用内置 `image/offload` 事件？**
这是 DSH 自己的 durable 事件类型，已经登记在 `KNOWN_SESSION_EVENT_TYPES` 里，语义与重放解释器都归 `dsh-compaction-image-offload` 所有。本插件**默认不注册** projection，只在检测到内置解释器缺席时才注册一份等价兜底。好处是：

- 两个插件装/卸互不依赖
- 本插件卸载后，历史会话照旧能读（`image/offload` 是内置认识的事件）
- 不会出现「两个插件抢注同一个 projection type」的启动崩溃

**为什么不顺手把阈值写进 provider 配置？**
那是另一条路（把 `maxRequestImageBytes` 降到真实上限，让内置插件的预算闸门提前响）。它有效，但需要重启、且要为每个 provider 维护一个魔法数字。本插件与它**互补不冲突** —— 两者都走 `image/offload`，同时装也只会多 offload 一轮。

## 边界

- **只处理图片**。纯文本或文件把体积撑爆时，本插件帮不上忙（会打一条 warn 日志然后交回原错误）。那种情况该用 compaction。
- **不碰上下文窗口超限**（`CONTEXT_WINDOW_EXCEEDED`）。那是 token 层面的问题，归 `compaction-basic` 管，硬 offload 图片只会答非所问。
- **offload 不可逆**（与内置插件语义一致）。但图片本体一直在磁盘上，模型随时可以 `read_image` 回读 —— 不可逆的只是「这一轮是否发送字节流」。

## 自检

```bash
node test/self-check.mjs        # 22 组单元 + 端到端用例
node test/dead-session-dryrun.mjs   # 用真实死档数据干跑
```

11 组用例，覆盖：

- imageIndex 语义与**真实内置 projection 的交叉验证**（最关键 —— 差一位就会标错图或让 projection 抛错）
- 跨消息累积、已有 offload 上的二次挑选、幂等
- 渐进收敛轨迹（24 张图 6 轮内清空）
- 413 措辞识别与**反例**（不误伤 context-window / rate-limit / timeout）
- 空会话、无图会话
- **主开关**：`enabled=false` 不挂监听不注册投影；`enabled=true` 正常挂载
- **端到端**：413 → 写 `image/offload` → 返回 retry；非 413 放行；无图可移时 warn；
  重试超限后交回原错误；换 step 计数重置

共 **22 组**用例。

## License

MIT
