/**
 * dsh-payload-guard — 413「Request payload is too large」自愈。
 *
 * ## 解决什么问题
 *
 * 上游网关的请求体上限往往比 DSH 适配器的图片预算小（实测某网关不到 5MB，
 * 而 `llm-pi-ai` 的 `maxRequestImageBytes` 默认 20MiB）。图片一多，适配器的
 * 预算闸门永远不响，直到上游直接回 413。而 413 被适配器归类为
 * `INVALID_REQUEST`，**不在** `dsh-llm-retry` 的 `retryableCodes` 里 —— 于是
 * 不重试、不降级、回合直接终止。会话上下文里那堆图片删不掉，于是每次发消息
 * 都必然 413，会话就此「死档」。
 *
 * ## 怎么做
 *
 * 拦 `agent/request-error`：一旦认出 413，就把当前 surface 里**最老的**若干张
 * 图片追加成一条 `image/offload` 决定，然后返回 `{kind: "retry"}`。
 * agent loop 会重新 `deriveMessages()` 并再发一次请求 —— 这一次被选中的图片
 * 已经由适配器渲染成 `offloadedImageText()`：一段带**本地绝对路径**的占位文本。
 * 图片少了，请求就能过。
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
 * ## 为什么这样设计
 *
 * - **被动触发**：只在真的 413 之后动手，不预设各家网关的真实上限，零误伤。
 * - **复用内置事件**：`image/offload` 是 DSH 自己的 durable 事件类型（已登记在
 *   已知事件表里）。默认由 `dsh-compaction-image-offload` 提供解释器；本插件
 *   只在检测到该解释器缺席时，才注册一份等价实现兜底。因此装/卸互不依赖 ——
 *   本插件卸载后历史会话照旧能读。
 * - **渐进式**：每轮只移出「剩余图片」的一部分（默认一半），反复 413 时逐轮
 *   收敛，避免一次性把图全推掉。
 * - **有上限**：同一步内最多重试 `maxRetriesPerStep` 次，防止和上游互相踢皮球
 *   转圈；耗尽后把错误原样抛回，行为与没装插件时一致。
 *
 * @module dsh-payload-guard
 */

/** Cordis 插件名。 */
export const name = 'payload-guard';

/**
 * 本插件依赖的服务。`sessions` 用来读 surface 与（必要时）注册兜底解释器。
 */
export const inject = ['sessions'];

/** 默认单轮最多移出的图片张数。 */
const DEFAULT_MAX_OFFLOAD_PER_RETRY = 12;
/** 默认同一步内最多自愈重试次数。 */
const DEFAULT_MAX_RETRIES_PER_STEP = 6;
/** 默认单轮移出比例（对「剩余未移出图片」而言）。 */
const DEFAULT_OFFLOAD_RATIO = 0.5;

/**
 * 认定一个失败是不是「请求体过大」。
 *
 * 上游各家措辞不一，这里同时认几类证据：失败消息里出现 413 / payload too large
 * 等明确措辞；或失败码就是 `INVALID_REQUEST`（pi-ai 适配器把 413 归到这一类）。
 *
 * 反过来，**必须排除**「上下文窗口超限」—— 那是 token 层面的问题，该交给
 * `compaction-basic` 去压缩，本插件硬 offload 图片只会答非所问。
 *
 * @param failure - agent loop 交给 `agent/request-error` 的失败描述。
 * @returns 是否应按请求体过大处理。
 */
export function isPayloadTooLarge(failure) {
  if (failure === undefined || failure === null) return false;
  const code = typeof failure.code === 'string' ? failure.code : '';
  const message = typeof failure.message === 'string' ? failure.message : '';
  // 上下文窗口超限有自己的恢复通道，这里一律不碰。
  if (code === 'CONTEXT_WINDOW_EXCEEDED') return false;
  if (/context[ _-]?window|maximum context|too many tokens/iu.test(message)) return false;
  if (/\b413\b/u.test(message)) return true;
  if (/payload\s+(?:is\s+)?too\s+large|request\s+(?:body|entity|payload)\s+too\s+large/iu.test(message)) {
    return true;
  }
  if (/failed to buffer the request body/iu.test(message)) return true;
  if (/length limit exceeded/iu.test(message)) return true;
  // 措辞没命中时，退回失败码：413 被适配器归类为 INVALID_REQUEST。
  return code === 'INVALID_REQUEST';
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
    maxRetriesPerStep: Math.floor(
      clamp(source.maxRetriesPerStep, 1, 50, DEFAULT_MAX_RETRIES_PER_STEP),
    ),
  };
}

/**
 * 内置 `image/offload` 解释器的等价实现，仅在检测到它缺席时用作兜底。
 *
 * 语义与 `@deepseek-ai/dsh-compaction-image-offload` 的 projection 一致：
 * 按 `{seq, imageIndexes}` 找到具体的 image 块，打上 `offloaded: true`。
 * 校验从严 —— 索引越界或重复 offload 都直接抛错，让问题暴露在写入侧，
 * 而不是悄悄生成一个和日志对不上的请求。
 */
export function createFallbackProjection() {
  const isIndex = (value) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
  const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

  const markImages = (message, indexes) => {
    let imageIndex = 0;
    let selected = 0;
    let next;
    for (const [index, block] of message.content.entries()) {
      let projected = block;
      if (block?.type === 'image') {
        if (imageIndex === indexes[selected]) {
          if (block.offloaded === true) {
            throw new Error(`image/offload: image index ${imageIndex} is already offloaded`);
          }
          projected = { ...block, offloaded: true };
          selected += 1;
        }
        imageIndex += 1;
      }
      if (projected !== block) next ??= message.content.slice(0, index);
      next?.push(projected);
    }
    const content = next ?? message.content;
    if (selected !== indexes.length) {
      throw new Error(`image/offload: image index ${indexes[selected]} does not exist`);
    }
    return { ...message, content };
  };

  return {
    type: 'image/offload',
    project(event, context) {
      const data = event.data;
      if (!isRecord(data) || !Array.isArray(data.targets) || data.targets.length === 0) {
        throw new Error('image/offload: data must contain a nonempty targets array');
      }
      const nodes = new Set(context.nodes);
      const messages = new Map();
      for (const target of data.targets) {
        if (!isRecord(target) || !isIndex(target.seq) || !Array.isArray(target.imageIndexes)) {
          throw new Error('image/offload: each target must contain a seq and imageIndexes');
        }
        const { seq } = target;
        if (messages.has(seq)) throw new Error(`image/offload: duplicate target seq ${seq}`);
        if (!nodes.has(seq)) {
          throw new Error(`image/offload: target seq ${seq} is not a current surface node`);
        }
        const source = context.events[seq - context.baseSeq];
        if (source?.type !== 'user/message' && source?.type !== 'tool/result') {
          throw new Error(`image/offload: target seq ${seq} must be user/message or tool/result`);
        }
        let previous = -1;
        for (const index of target.imageIndexes) {
          if (!isIndex(index) || index <= previous) {
            throw new Error('image/offload: imageIndexes must be strictly increasing');
          }
          previous = index;
        }
        const message =
          context.messages.get(seq) ??
          (source.type === 'user/message' ? source.data : source.data.message);
        messages.set(seq, markImages(message, target.imageIndexes));
      }
      return messages;
    },
  };
}

/**
 * 装配插件。
 *
 * 只挂一个瀑布监听：`agent/request-error`。这个钩子在一次请求失败之后、回合
 * 终止之前被调用，返回值决定接下来怎么走 —— 返回 `{kind: "retry"}` 就重发。
 *
 * 重试计数以「turn/step」为键按 agent 隔离，进入新 step 自然归零，不需要额外
 * 清理钩子，也不会把计数泄漏到下一次对话。
 *
 * @param ctx - cordis 插件上下文。
 * @param rawConfig - 来自 `cordis.patch.yml` 的原始配置。
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);

  // 主开关关闭时什么都不挂：不注册解释器、不监听 413。
  // 于是 413 照旧直接失败，图片预算仍是适配器默认的 20 MiB —— 与没装本插件完全一致。
  if (!config.enabled) {
    ctx.logger?.info(
      'payload-guard: enabled=false，已停用 413 自愈；413 将按 DSH 原生行为直接失败（图片预算保持默认 20 MiB）',
    );
    return;
  }

  /** 每个 agent 各 step 已自愈重试的次数。 */
  const attempts = new WeakMap();

  const bumpAttempts = (agent, turn, step) => {
    let perAgent = attempts.get(agent);
    if (perAgent === undefined) {
      perAgent = new Map();
      attempts.set(agent, perAgent);
    }
    const key = `${turn}/${step}`;
    const next = (perAgent.get(key) ?? 0) + 1;
    perAgent.set(key, next);
    // 只保留有限个键，避免长会话里无界增长。
    if (perAgent.size > 64) {
      const oldest = perAgent.keys().next();
      if (!oldest.done) perAgent.delete(oldest.value);
    }
    return next;
  };

  // 兜底：只有当内置 image-offload 解释器缺席时才自己注册一份。
  const registered = ctx.sessions.messageProjections?.some(
    (projection) => projection.type === 'image/offload',
  );
  if (registered !== true) {
    ctx.sessions.registerMessageProjection(createFallbackProjection());
    ctx.logger?.info('payload-guard: 未检测到内置 image/offload 解释器，已注册等价兜底实现');
  }

  ctx.on('agent/request-error', ({ agent, turn, step, failure, signal }, next) => {
    // 已经取消的请求没必要再修，交给框架按中断处理。
    if (signal?.aborted === true) return next();
    if (!isPayloadTooLarge(failure)) return next();

    const used = bumpAttempts(agent, turn, step);
    if (used > config.maxRetriesPerStep) {
      ctx.logger?.warn(
        `payload-guard: ${used - 1} 次 offload 重试后仍然 payload too large，放弃并交回原错误`,
      );
      return next();
    }

    const retained = scanRetainedImages(agent.session);
    if (retained.length === 0) {
      // 一张可移出的图都没有 —— 多半是纯文本/文件把体积撑爆的，本插件帮不上忙。
      ctx.logger?.warn(
        'payload-guard: 收到 payload too large，但上下文里已无可移出的图片（可能是纯文本/文件过大）',
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

    ctx.logger?.info(
      `payload-guard: 请求体过大，已把 ${movedImages} 张图片（约 ${(movedBytes / 1048576).toFixed(2)} MiB）`
        + ` 换成本地路径占位文本，自动重试（第 ${used}/${config.maxRetriesPerStep} 次）`,
    );

    return { kind: 'retry' };
  });
}
