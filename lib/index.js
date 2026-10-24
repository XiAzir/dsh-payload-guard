/**
 * dsh-payload-guard — 请求体超限（HTTP 413）自愈。
 *
 * ## 解决什么问题
 *
 * 上游网关的请求体上限往往比 DSH 适配器的图片预算小（实测某网关约 10MB 就会
 * 413，而 `llm-pi-ai` 的 `maxRequestImageBytes` 默认 20MiB）。图片一多，适配器
 * 的预算闸门永远不响，直到上游直接拒绝。而 413 被适配器归类为
 * `INVALID_REQUEST`，**不在** `dsh-llm-retry` 的 `retryableCodes` 里 —— 于是
 * 不重试、不降级、回合直接终止。上下文里那堆图片又删不掉，于是之后每次发消息
 * 都必然再撞一次墙，会话就此「死档」。
 *
 * ## 怎么做
 *
 * 拦 `agent/request-error`：一旦认出请求体超限，就把当前 surface 里**最老的**
 * 若干张图片追加成一条 `image/offload` 决定，然后返回 `{kind: "retry"}`。
 * agent loop 会重新 `deriveMessages()` 并再发一次请求 —— 这一次被选中的图片
 * 已经由适配器渲染成 `offloadedImageText()`：一段带**本地绝对路径**的占位文本。
 *
 * 模型看到的占位形如：
 *
 *   [image omitted to fit request image limits; "chest_crop.png" (sha256:...).
 *    Normalized copy (read-only; may be resized or re-encoded):
 *    "C:\Users\...\.dsh\attachments\v1\objects\e0\<sha256>" (520x360px, image/png).
 *    Source dimensions, format, and byte size may differ. ...]
 *
 * 想再看那张图，模型用 `read_image` 读那个路径即可（`read_image` 支持无扩展名
 * 文件，按 magic bytes 嗅探格式，无需先复制成 .png）。
 *
 * ## 设计取舍
 *
 * - **被动触发**：只在真的失败之后动手。各家网关真实上限既不公开也不一致
 *   （有 5MB 的，有 10MB 的，有几十 MB 的），提前猜阈值要么误伤要么漏判。
 * - **复用内置事件，不抢注解释器**：`image/offload` 是 DSH 自己的 durable 事件
 *   类型，解释器归 `dsh-compaction-image-offload` 所有。本插件只**使用**它，
 *   缺席就明确放弃（fail-closed），绝不注册第二份 —— 抢注会让官方插件随后
 *   注册时抛 "already registered"，运行期动投影表还可能让已折叠的会话重放失败。
 * - **渐进式**：每轮只移出「剩余图片」的一部分（默认一半）。理由是保住模型的
 *   视觉上下文 —— 移出的图会变成占位文本，模型必须主动回读才能再看见。一次
 *   全移出会把「比较两张图」这类任务变成「读了又被卸」的死循环。
 * - **按回合封顶**：`maxRecoveriesPerTurn` 限制同一回合的恢复次数。按 step 计
 *   会被 step 边界重置，等于对跨 step 的反复超限完全不设限。
 * - **只做行为引导，不做强制拦截**：卸载后注入一段固定提示，提醒模型「需要
 *   看图时一次只读一张」。提示是 user-role 的运行时上下文，不是硬约束，因此
 *   不能替代回合预算。
 *
 * ## 已知代价（诚实记录）
 *
 * - **改历史会破坏提示缓存**：卸载发生在历史中间时，该位置**之后**的前缀缓存
 *   会失效（之前的部分仍可命中）。这是修改历史的固有代价，即使只在 413 之后
 *   触发也不是零成本 —— 失败请求之前那些成功请求可能已经建立了很长的缓存前缀。
 * - **缓存不解决体积**：prompt cache 只省计算与费用，请求体该有多大还是多大。
 *
 * @module dsh-payload-guard
 */

/** Cordis 插件名。 */
export const name = 'payload-guard';

/**
 * 本插件依赖的服务。`sessions` 用来读 surface 与检测解释器；
 * `systemPrompt` 用来注入「已发生卸载」的行为提示（可选能力）。
 */
export const inject = ['sessions'];

/** 默认单轮最多移出的图片张数。 */
const DEFAULT_MAX_OFFLOAD_PER_RETRY = 12;
/** 默认同一回合内最多自愈重试次数。 */
const DEFAULT_MAX_RECOVERIES_PER_TURN = 5;
/** 默认单轮移出比例（对「剩余未移出图片」而言）。 */
const DEFAULT_OFFLOAD_RATIO = 0.5;

/**
 * 注入给模型的固定提示文本。
 *
 * 刻意**不含**任何累计次数或可变数据：DSH 的 runtime context 是 append 语义
 * （`surfaceOp: "append"`），文本一旦变化就会追加一份新的完整快照，旧快照仍留在
 * 上下文里。固定文本保证正常情况下只新增一份，不会随恢复次数增长而堆积。
 *
 * 措辞只写**能确证的事实**，两点尤其注意：
 * 1. 不把原因归给「网关超限」—— 本插件的激活状态也会从官方主动卸载产生的
 *    `image/offload` 事件重建，那时原因并非 413。所以只说「曾被卸载」。
 * 2. 不承诺「一定能回读」—— `offloadedImageText()` 在拿不到可读路径时只给附件
 *    身份，不保证有路径。
 */
const OFFLOAD_NOTICE = [
  '[payload-guard] 本会话历史中曾有图片出现位置被卸载，以减少后续模型请求的图片载荷。',
  '卸载操作不会主动删除原始附件；如果占位文本提供了当前执行环境可读取的本地路径，',
  '可以使用 read_image 按需回读，否则不能保证能够重新读取该图片。',
  '为避免再次触发体积上限：需要看图时请一次只回读一张，判断完再决定是否读下一张；',
  '不要为了「先看一眼」而批量回读多张历史图片。',
].join('');

/**
 * 认定一个失败是不是「请求体过大」。
 *
 * 判定顺序（这个顺序本身就是安全边界）：
 * 1. 先排除「上下文窗口超限」—— 那是 token 层面问题，归 compaction 管。
 * 2. **若适配器提供了 `status`，就只看它**：`status === 413` 才算，其余一概不算。
 *    大多数适配器不填 `status`（`dsh-llm-pi-ai` 从不填，`dsh-llm-deepseek` 会填），
 *    但一旦填了就是权威信息，不该再被消息文本里的字样推翻。
 * 3. `status` 缺席时，才退回文本识别（pi-ai 走这条路径）。
 *
 * **刻意不退回 `code === 'INVALID_REQUEST'`**：pi-ai 把 400 和 413 都归成这一个码，
 * 裸退会让参数错误、格式错误也触发**持久化**的图片卸载。卸载是破坏性且不可逆的
 * 操作，宁可漏判（交回原错误）也不能误判。
 *
 * @param failure - agent loop 交给 `agent/request-error` 的失败描述。
 * @returns 是否应按请求体过大处理。
 */
export function isPayloadTooLarge(failure) {
  if (failure === undefined || failure === null) return false;
  const code = typeof failure.code === 'string' ? failure.code : '';
  const message = typeof failure.message === 'string' ? failure.message : '';
  const status = typeof failure.status === 'number' ? failure.status : undefined;

  // 上下文窗口超限有自己的恢复通道，这里一律不碰。
  if (code === 'CONTEXT_WINDOW_EXCEEDED') return false;
  if (/context[ _-]?window|maximum context|too many tokens/iu.test(message)) return false;

  // 适配器提供了 HTTP 状态码时，**以它为准，不再看文本**。
  // 否则已知是 400/500 的请求会因为消息里恰好出现 "413" / "payload too large"
  // 之类的字样而被误判（例如 `HTTP 400: invalid field value "413"`），
  // 进而触发不可逆的历史改写。
  if (status !== undefined) return status === 413;

  // 以下是「适配器没给 status」时的文本识别（pi-ai 就走这条路径）。
  if (/\b413\b/u.test(message)) return true;
  if (/payload\s+(?:is\s+)?too\s+large|request\s+(?:body|entity|payload)\s+too\s+large/iu.test(message)) {
    return true;
  }
  if (/request_too_large/iu.test(message)) return true;
  // 只匹配「请求体」语境的缓冲失败。裸 "length limit exceeded" 会误命中
  // "message length limit exceeded" / "context length limit exceeded" 之类
  // 与 HTTP body 无关的限制 —— 对会持久化改历史的处理器，误判代价太高。
  if (/failed to buffer the request body/iu.test(message)) return true;

  // 到这里就放弃：不再用 INVALID_REQUEST 兜底（见上方说明）。
  return false;
}

/**
 * 枚举当前 surface 里所有**尚未 offload** 的图片出现位置，按日志顺序（≈请求顺序）。
 *
 * 图片索引的语义必须与内置 `image/offload` 的 projection **逐字一致**：对单条消息的
 * `content` 顶层数组顺序计数，**包含已 offload 的那些**（它们同样占一个 index）。
 *
 * 注意内置实现只遍历顶层、不递归进嵌套块。这里必须同样不递归 —— 一旦多算或
 * 少算一个 index，projection 就会把错误的图打上 offloaded 标记，或者直接抛
 * 「image index does not exist」。
 *
 * @param session - 目标会话。
 * @returns 每个未 offload 出现位置的 `{seq, imageIndex, bytes}`，最老的在前。
 */
export function scanRetainedImages(session) {
  const found = [];
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    if (event.type !== 'user/message' && event.type !== 'tool/result') continue;
    const message = session.deriveEventMessage(event);
    if (message === undefined || message === null) continue;
    let imageIndex = 0;
    for (const block of message.content ?? []) {
      if (block === undefined || block === null) continue;
      if (block.type !== 'image') continue;
      if (block.offloaded !== true) {
        const bytes = block.attachment?.bytes;
        found.push({
          seq,
          imageIndex,
          bytes: typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0,
        });
      }
      imageIndex += 1;
    }
  }
  return found;
}

/**
 * 挑出这一轮该移出的图片，并折叠成 `image/offload` 需要的 targets 形状。
 *
 * targets 要求：同一 seq 的 imageIndexes 严格递增，且每个 seq 只出现一次。
 * 下面按扫描顺序推进，天然满足；归并时再排一次序作为保险。
 *
 * @param retained - {@link scanRetainedImages} 的结果。
 * @param limit - 本轮最多移出几张。
 * @returns 可直接写进事件的 targets 数组。
 */
export function pickTargets(retained, limit) {
  const chosen = retained.slice(0, Math.max(0, limit));
  const bySeq = new Map();
  for (const entry of chosen) {
    const list = bySeq.get(entry.seq);
    if (list === undefined) bySeq.set(entry.seq, [entry.imageIndex]);
    else list.push(entry.imageIndex);
  }
  const targets = [];
  for (const [seq, imageIndexes] of bySeq) {
    imageIndexes.sort((a, b) => a - b);
    targets.push({ seq, imageIndexes });
  }
  return targets;
}

/**
 * 算这一轮移多少张。
 *
 * 默认「剩余未 offload 图片的一半」，并受 `maxOffloadPerRetry` 约束。至少 1 张，
 * 否则永远推不动。之所以按比例而不是固定值：图片少时一轮就能解决；图片多时
 * （比如二十几张大图）逐轮收敛，也不至于一次把上下文图片清空。
 *
 * @param retainedCount - 当前剩余未 offload 的图片张数。
 * @param config - 解析后的插件配置。
 * @returns 本轮移出张数，0 表示无可移出。
 */
export function planOffloadCount(retainedCount, config) {
  if (retainedCount <= 0) return 0;
  const proportional = Math.ceil(retainedCount * config.offloadRatio);
  return Math.min(Math.max(proportional, 1), config.maxOffloadPerRetry, retainedCount);
}

/**
 * 把配置对象规整成带默认值的形态，越界值钳制而不是抛错。
 *
 * `enabled` 是本插件的主开关：
 * - `true`（默认）：413 触发救援 —— 换本地路径占位文本后自动重试。
 * - `false`：完全退回 DSH 原生行为 —— 413 照旧直接失败，图片预算仍是适配器
 *   默认的 20 MiB，内置 `dsh-compaction-image-offload` 的既有能力不受影响。
 *   本插件在 `enabled: false` 时**不挂任何监听**，等价于没装。
 *
 * 换句话说：关掉它损失的不是「20 MB 预算」（那是内置的、一直都在），
 * 而是「上游实际阈值远小于 20 MB 时的兜底」。
 */
export function resolveConfig(input) {
  const source = input ?? {};
  const clamp = (value, min, max, fallback) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(Math.max(value, min), max);
  };
  return {
    enabled: source.enabled !== false,
    offloadRatio: clamp(source.offloadRatio, 0.05, 1, DEFAULT_OFFLOAD_RATIO),
    maxOffloadPerRetry: Math.floor(
      clamp(source.maxOffloadPerRetry, 1, 200, DEFAULT_MAX_OFFLOAD_PER_RETRY),
    ),
    // 按回合（turn）计，而不是按 step：step 边界会重置计数，导致跨 step 的
    // 「回读 → 超限 → 再卸载」循环完全不受限。按回合计才能真正封顶。
    maxRecoveriesPerTurn: Math.floor(
      clamp(source.maxRecoveriesPerTurn, 1, 50, DEFAULT_MAX_RECOVERIES_PER_TURN),
    ),
    // 注入行为提示的开关。关闭后不注册 systemPrompt.context。
    notice: source.notice !== false,
  };
}

/**
 * 装配插件。
 *
 * 只挂一个瀑布监听：`agent/request-error`。这个钩子在一次请求失败之后、回合
 * 终止之前被调用，返回值决定接下来怎么走 —— 返回 `{kind: "retry"}` 就重发。
 *
 * 两个安全边界：
 * - **恢复预算按回合计**（`maxRecoveriesPerTurn`）。按 step 计会被 step 边界重置，
 *   等于对「回读 → 超限 → 再卸载」这类跨 step 循环完全不设限。
 * - **不做兜底 projection 注册**。`image/offload` 的解释器归内置
 *   `dsh-compaction-image-offload` 所有；缺席时本插件明确放弃，而不是抢注一份
 *   自己的。理由：抢注会让官方插件随后注册时抛 "already registered"，而运行期
 *   动投影表还可能让已折叠的会话重放失败。宁可这次不救，也不制造更坏的状态。
 *
 * @param ctx - cordis 插件上下文。
 * @param rawConfig - 来自 `cordis.patch.yml` 的原始配置。
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);

  // 主开关关闭时什么都不挂：不注册提示、不监听 413。
  // 于是 413 照旧直接失败，图片预算仍是适配器默认的 20 MiB —— 与没装本插件完全一致。
  if (!config.enabled) {
    ctx.logger?.info(
      'payload-guard: enabled=false，已停用 413 自愈；413 将按 DSH 原生行为直接失败（图片预算保持默认 20 MiB）',
    );
    return;
  }

  // 解释器必须由内置插件提供。缺席时 fail-closed：不抢注、不假装能工作。
  const hasProjection = ctx.sessions.messageProjections?.some(
    (projection) => projection.type === 'image/offload',
  );
  if (hasProjection !== true) {
    ctx.logger?.warn(
      'payload-guard: 未检测到 image/offload 解释器（内置 dsh-compaction-image-offload 未装载），'
        + '本插件不做自动恢复，避免写入无法解释的持久化事件。装载该插件后重载 payload-guard 即可启用。',
    );
    return;
  }

  /** 每个 agent 当前回合已用的恢复次数与所属回合。 */
  const budgets = new WeakMap();

  /** 取本回合已用次数；进入新回合自动归零。 */
  const usedInTurn = (agent, turn) => {
    const current = budgets.get(agent);
    if (current === undefined || current.turn !== turn) return 0;
    return current.used;
  };

  const spendOne = (agent, turn) => {
    const current = budgets.get(agent);
    const used = current === undefined || current.turn !== turn ? 0 : current.used;
    budgets.set(agent, { turn, used: used + 1 });
    return used + 1;
  };

  /** 该 agent 是否已发生过卸载 —— 决定要不要把行为提示暴露给模型。 */
  const noticeState = new WeakMap();
  const markNotified = (agent) => {
    noticeState.set(agent, true);
  };

  /**
   * 判断该 agent 的会话里是否**已经存在** `image/offload` 事件。
   *
   * 只靠内存里的 WeakMap 是不够的：恢复持久化会话、fork 分支、或插件晚于会话
   * 加载时，WeakMap 是空的，但历史里的 offload 事件还在。此时若不从日志重建，
   * 提示会「丢失」—— 图片仍处于卸载状态，模型却收不到「一次只读一张」的引导。
   *
   * 官方 `RuntimeContextProjection` 正是用「回扫历史事件」来恢复这类状态的，
   * 这里采用同一思路。区别是额外记住**扫描到了哪个序号**，避免每次计算动态
   * context 都把整段历史重扫一遍（长会话下那是纯浪费）。
   */
  const scans = new WeakMap();

  const hasOffloadEvent = (agent) => {
    const session = agent?.session;
    if (session === undefined) return false;
    const total = typeof session.seq === 'number' ? session.seq : 0;
    const progress = scans.get(agent);
    // 已经扫完且确认存在，直接返回。
    if (progress?.found === true) return true;
    // 从上次扫到的位置继续，只检查新增事件。
    const from = progress === undefined ? total - 1 : Math.min(total - 1, progress.checkedUpTo + 1);
    for (let seq = from; seq >= 0; seq -= 1) {
      const event = session.eventAt?.(seq);
      if (event === undefined) continue;
      if (event.type === 'image/offload') {
        scans.set(agent, { checkedUpTo: total - 1, found: true });
        return true;
      }
    }
    scans.set(agent, { checkedUpTo: total - 1, found: false });
    return false;
  };

  const isNotified = (agent) => {
    if (noticeState.get(agent) === true) return true;
    // 内存里没有时，回扫日志重建 —— 覆盖恢复 / fork / 晚加载三种情形。
    const session = agent?.session;
    if (session === undefined) return false;
    if (hasOffloadEvent(agent)) {
      noticeState.set(agent, true);
      return true;
    }
    return false;
  };

  // 注入固定文本的动态上下文。未发生过卸载时返回空串，DSH 不会为它新增快照。
  // 用 ctx.inject 获取 systemPrompt；缺失该能力时静默跳过（提示是可选增强，
  // 不该因为它让整个插件装不上）。
  if (config.notice && typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt?.context({
        name: 'payload-guard:offload-notice',
        // 放在其它运行时上下文之后：它是「刚发生过的事」的说明，不是基础事实。
        order: 9000,
        text: (context) => {
          const agent = context?.agent;
          return agent === undefined || !isNotified(agent) ? '' : OFFLOAD_NOTICE;
        },
      });
    });
  }

  ctx.on('agent/request-error', ({ agent, turn, failure, signal }, next) => {
    // 已经取消的请求没必要再修，交给框架按中断处理。
    if (signal?.aborted === true) return next();
    if (!isPayloadTooLarge(failure)) return next();

    const used = usedInTurn(agent, turn);
    if (used >= config.maxRecoveriesPerTurn) {
      ctx.logger?.warn(
        `payload-guard: 本回合已自动恢复 ${used} 次，仍出现请求体超限，停止自动恢复并交回原错误。`
          + '若持续出现，考虑压缩会话或新开会话；上下文里可能已无足够的可移出图片。',
      );
      return next();
    }

    const retained = scanRetainedImages(agent.session);
    if (retained.length === 0) {
      // 一张可移出的图都没有 —— 多半是纯文本/文件把体积撑爆的，本插件帮不上忙。
      // 注意措辞：只陈述可证实的现象，不把 413 归因于图片。
      ctx.logger?.warn(
        'payload-guard: 收到请求体超限，但上下文里已无可移出的图片（可能来自文本、文件或其它载荷），本插件不适用。',
      );
      return next();
    }

    const count = planOffloadCount(retained.length, config);
    const targets = pickTargets(retained, count);
    if (targets.length === 0) return next();

    const movedImages = targets.reduce((sum, target) => sum + target.imageIndexes.length, 0);
    const movedBytes = retained
      .slice(0, movedImages)
      .reduce((sum, entry) => sum + entry.bytes, 0);

    try {
      agent.session.append('image/offload', { targets });
    } catch (error) {
      ctx.logger?.warn(`payload-guard: 写入 image/offload 失败，交回原错误: ${String(error)}`);
      return next();
    }

    const attempt = spendOne(agent, turn);
    // 卸载成功后立刻激活提示：模型在下一次请求就会看到它。
    markNotified(agent);

    ctx.logger?.info(
      `payload-guard: 请求体超限，已把 ${movedImages} 张图片（约 ${(movedBytes / 1048576).toFixed(2)} MiB）`
        + ` 换成本地路径占位文本并重试（本回合第 ${attempt}/${config.maxRecoveriesPerTurn} 次）。`
        + '注意：修改历史图片会使该位置之后的提示缓存前缀失效。',
    );

    return { kind: 'retry' };
  });
}
