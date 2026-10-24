/**
 * 自检脚本：不依赖 DSH 运行时，验证 payload-guard 的几条关键不变量。
 *
 * 直接 import 插件的**真实实现**（不是复制品），再拿 npm 全局 DSH checkout 里
 * 已发布的 `imageOffloadProjection` 做交叉验证 —— 这是最关键的一条：插件算出
 * 的 imageIndex 只要和内置 projection 差一位，就会把错误的图打上 offloaded
 * 标记，或者让 projection 抛错把整个会话写坏。
 *
 * 跑法：node test/self-check.mjs
 */

import assert from 'node:assert/strict';

import {
  apply,
  isPayloadTooLarge,
  pickTargets,
  planOffloadCount,
  resolveConfig,
  scanRetainedImages,
} from '../lib/index.js';
import { loadBuiltinProjection } from './builtin-projection.mjs';

// 交叉验证用的官方 projection。本机找不到该包时跳过相关用例（而不是失败）：
// 那是环境差异，不是插件缺陷。
const builtin = await loadBuiltinProjection();
const imageOffloadProjection = builtin?.imageOffloadProjection ?? null;

// ------------------------------- 假会话构造 --------------------------------

const makeRef = (id, bytes) => ({
  attachmentId: `sha256:${id}`,
  mediaType: 'image/png',
  width: 1280,
  height: 720,
  bytes,
  name: `${id}.png`,
});

const makeImage = (id, bytes) => ({ type: 'image', attachment: makeRef(id, bytes) });

/**
 * 造一个带 surface / eventAt / deriveEventMessage 的假 session。
 *
 * 事件结构与真实日志保持一致：`user/message` 的消息就是 `event.data` 本身，
 * `tool/result` 的消息在 `event.data.message` 里 —— 内置 projection 依赖这个
 * 差别来取消息，假数据必须同构，否则验证的是错的东西。
 */
function makeSession(entries) {
  const events = new Map();
  for (const [seq, kind, message] of entries) {
    const event =
      kind === 'user/message'
        ? { type: kind, seq, data: message }
        : { type: kind, seq, data: { message } };
    events.set(seq, event);
  }
  return {
    surface: { nodes: [...events.keys()].sort((a, b) => a - b) },
    eventAt: (seq) => events.get(seq),
    deriveEventMessage: (event) =>
      event.type === 'user/message' ? event.data : event.data.message,
  };
}

/** 用真实 projection 投影一次，返回被标记的图片 flags。 */
function project(session, targets, baseSeq) {
  const nodes = session.surface.nodes;
  const context = {
    nodes,
    baseSeq,
    // 官方 projection 用 events[seq - baseSeq] 直接索引，必须按 seq 对齐。
    events: nodes.map((seq) => session.eventAt(seq)),
    messages: new Map(),
  };
  return imageOffloadProjection.project({ type: 'image/offload', data: { targets } }, context);
}

// -------------------------------- 用例 ------------------------------------

let passed = 0;
let skipped = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  \u2713 ${label}`);
};

/** 依赖内置 projection 的用例：本机没有该包时明确跳过。 */
const checkWithBuiltin = (label, fn) => {
  if (imageOffloadProjection === null) {
    skipped += 1;
    console.log(`  \u25cb ${label}（跳过：本机未找到 @deepseek-ai/dsh）`);
    return;
  }
  check(label, fn);
};

console.log('payload-guard 自检\n');
if (imageOffloadProjection === null) {
  console.log('  注意：未找到官方 DSH 安装，交叉验证用例将跳过\n');
} else {
  console.log(`  交叉验证目标: ${builtin.url}\n`);
}

check('scan 跳过已 offload，索引仍连续计数', () => {
  const msg = {
    content: [
      { type: 'text', text: 'hello' },
      makeImage('a', 100), // index 0
      { type: 'image', attachment: makeRef('b', 200), offloaded: true }, // index 1
      makeImage('c', 300), // index 2
    ],
  };
  const session = makeSession([[10, 'user/message', msg]]);
  const found = scanRetainedImages(session);
  assert.deepEqual(found.map((entry) => entry.imageIndex), [0, 2]);
  assert.deepEqual(found.map((entry) => entry.bytes), [100, 300]);
});

check('跨消息按日志顺序累积，最老的在前', () => {
  const session = makeSession([
    [10, 'user/message', { content: [makeImage('old1', 10), makeImage('old2', 20)] }],
    [11, 'tool/result', { content: [makeImage('mid', 30)] }],
    [12, 'user/message', { content: [makeImage('new', 40)] }],
  ]);
  const found = scanRetainedImages(session);
  assert.deepEqual(found.map((entry) => entry.seq), [10, 10, 11, 12]);
  assert.deepEqual(found.map((entry) => entry.imageIndex), [0, 1, 0, 0]);
});

checkWithBuiltin('与内置 projection 交叉验证：targets 精确标记目标图', () => {
  const s1 = {
    content: [
      makeImage('a', 1), // 0
      { type: 'text', text: 't' },
      makeImage('b', 2), // 1
      makeImage('c', 3), // 2
    ],
  };
  const s2 = { content: [makeImage('d', 4), makeImage('e', 5)] };
  const session = makeSession([
    [100, 'user/message', s1],
    [101, 'tool/result', s2],
  ]);

  const retained = scanRetainedImages(session);
  assert.equal(retained.length, 5);
  assert.deepEqual(retained.map((entry) => [entry.seq, entry.imageIndex]), [
    [100, 0], [100, 1], [100, 2], [101, 0], [101, 1],
  ]);

  // 挑最老 3 张 → 全在 seq 100
  const targets = pickTargets(retained, 3);
  assert.deepEqual(targets, [{ seq: 100, imageIndexes: [0, 1, 2] }]);

  const projected = project(session, targets, 100);
  const out = projected.get(100);
  assert.ok(out, 'projection 必须返回 seq 100 的投影消息');
  const images = out.content.filter((block) => block.type === 'image');
  assert.equal(images.length, 3, '图片数量不应改变');
  assert.deepEqual(images.map((block) => block.offloaded === true), [true, true, true]);
  assert.ok(!projected.has(101), '未选中的 seq 不应产生投影');
});

checkWithBuiltin('与内置 projection 交叉验证：跨 seq 部分选中', () => {
  const s1 = { content: [makeImage('a', 1), makeImage('b', 2)] };
  const s2 = { content: [makeImage('c', 3), makeImage('d', 4)] };
  const session = makeSession([
    [200, 'user/message', s1],
    [201, 'tool/result', s2],
  ]);

  const retained = scanRetainedImages(session);
  // 挑最老 3 张 → seq200 的 0,1 + seq201 的 0
  const targets = pickTargets(retained, 3);
  assert.deepEqual(targets, [
    { seq: 200, imageIndexes: [0, 1] },
    { seq: 201, imageIndexes: [0] },
  ]);

  const projected = project(session, targets, 200);
  const first = projected.get(200).content.filter((b) => b.type === 'image');
  const second = projected.get(201).content.filter((b) => b.type === 'image');
  assert.deepEqual(first.map((b) => b.offloaded === true), [true, true]);
  assert.deepEqual(second.map((b) => b.offloaded === true), [true, false], 'seq201 只标第一张');
});

checkWithBuiltin('与内置 projection 交叉验证：已有 offload 的图上再挑，索引仍对齐', () => {
  // 模拟第二轮：index 0 已被上一轮 offload，这一轮应挑 index 1、2
  const msg = {
    content: [
      { type: 'image', attachment: makeRef('a', 1), offloaded: true }, // 0 已移出
      makeImage('b', 2), // 1
      makeImage('c', 3), // 2
    ],
  };
  const session = makeSession([[300, 'user/message', msg]]);
  const retained = scanRetainedImages(session);
  assert.deepEqual(retained.map((entry) => entry.imageIndex), [1, 2]);

  const targets = pickTargets(retained, 2);
  assert.deepEqual(targets, [{ seq: 300, imageIndexes: [1, 2] }]);

  const projected = project(session, targets, 300);
  const images = projected.get(300).content.filter((b) => b.type === 'image');
  assert.equal(images.length, 3);
  assert.deepEqual(
    images.map((b) => b.offloaded === true),
    [true, true, true],
    '三张最终都已 offload',
  );
});

check('渐进收敛：24 张图在重试上限内全部移出', () => {
  const config = { offloadRatio: 0.5, maxOffloadPerRetry: 12, maxRetriesPerStep: 6 };
  let remaining = 24;
  const trace = [];
  let guard = 0;
  while (remaining > 0 && guard < 32) {
    const count = planOffloadCount(remaining, config);
    assert.ok(count >= 1, '每轮至少推进 1 张');
    assert.ok(count <= remaining, '不能移出超过剩余数量');
    remaining -= count;
    trace.push(count);
    guard += 1;
  }
  console.log(`      收敛轨迹: 24 -> ${trace.join(' -> ')} -> 0`);
  assert.equal(remaining, 0);
  assert.ok(trace.length <= config.maxRetriesPerStep, '应在重试上限内收敛完');
});

check('planOffloadCount 边界', () => {
  const config = { offloadRatio: 0.5, maxOffloadPerRetry: 12, maxRetriesPerStep: 6 };
  assert.equal(planOffloadCount(0, config), 0);
  assert.equal(planOffloadCount(1, config), 1, '单张也要能推进');
  assert.equal(planOffloadCount(2, config), 1);
  assert.equal(planOffloadCount(100, config), 12, '受 maxOffloadPerRetry 约束');
});

check('413 识别：各种上游措辞都命中', () => {
  const cases = [
    // pi-ai 的真实失败对象：只有 message + code，没有 status。这是主路径。
    { message: '413: {"message":"Request payload is too large","type":"invalid_request_error"}', code: 'INVALID_REQUEST' },
    { message: 'payload too large', code: 'INVALID_REQUEST' },
    { message: 'Request entity too large', code: 'INVALID_REQUEST' },
    { message: 'request body too large', code: 'INVALID_REQUEST' },
    { message: 'failed to buffer the request body: length limit exceeded', code: 'INVALID_REQUEST' },
    { message: 'HTTP 413', code: 'UNKNOWN' },
    { message: '{"error":{"type":"request_too_large"}}', code: 'INVALID_REQUEST' },
    // 硬证据：部分适配器（如 dsh-llm-deepseek）会填 status。
    { message: 'something terse', code: 'INVALID_REQUEST', status: 413 },
  ];
  for (const failure of cases) {
    assert.equal(isPayloadTooLarge(failure), true, `应命中: ${failure.message}`);
  }
});

check('413 识别：裸 INVALID_REQUEST 不再触发（P0 安全边界）', () => {
  // 这是本插件最重要的安全边界：pi-ai 把 400 和 413 都归成 INVALID_REQUEST，
  // 若退回 code 判断，参数错误也会触发**持久化**图片卸载。宁可漏判不能误判。
  const mustNot = [
    { message: 'something odd', code: 'INVALID_REQUEST' },
    { message: 'Invalid request parameters', code: 'INVALID_REQUEST' },
    { message: 'unsupported parameter temperature', code: 'INVALID_REQUEST' },
    { message: 'messages.3.content.2.image.source.base64.data: Image does not match the provided media type', code: 'INVALID_REQUEST' },
  ];
  for (const failure of mustNot) {
    assert.equal(
      isPayloadTooLarge(failure),
      false,
      `绝不能命中（会误删图片）: ${failure.message}`,
    );
  }
});

check('413 识别：与 HTTP body 无关的 length limit 不得误判', () => {
  // 裸 "length limit exceeded" 会命中这些与请求体无关的限制，
  // 对会持久化改历史的处理器来说误判代价太高。
  const mustNot = [
    { message: 'message length limit exceeded 1000000 characters', code: 'INVALID_REQUEST' },
    { message: 'context length limit exceeded', code: 'INVALID_REQUEST' },
    { message: 'string length limit exceeded', code: 'INVALID_REQUEST' },
    { message: 'output length limit exceeded max_tokens', code: 'INVALID_REQUEST' },
  ];
  for (const failure of mustNot) {
    assert.equal(isPayloadTooLarge(failure), false, `不应命中: ${failure.message}`);
  }
  // 但真正的请求体缓冲失败仍应命中。
  assert.equal(
    isPayloadTooLarge({
      message: 'failed to buffer the request body: length limit exceeded',
      code: 'INVALID_REQUEST',
    }),
    true,
    '请求体缓冲失败必须命中',
  );
});

check('413 识别：已知 HTTP 状态码否决文本匹配（P0 安全边界）', () => {
  // 适配器填了 status 就是权威信息。否则消息里恰好出现的 "413" 字样会让
  // 已知 400/500 的请求被误判，触发不可逆的历史改写。
  const mustNot = [
    { status: 400, code: 'INVALID_REQUEST', message: 'HTTP 400: invalid field value "413"' },
    { status: 400, code: 'INVALID_REQUEST', message: 'bad request: payload too large param name' },
    { status: 500, code: 'SERVER', message: 'upstream 413 proxy error' },
    { status: 401, code: 'AUTH', message: 'request_too_large mentioned in auth docs' },
    { status: 429, code: 'RATE_LIMIT', message: 'retry after 413 ms' },
  ];
  for (const failure of mustNot) {
    assert.equal(
      isPayloadTooLarge(failure),
      false,
      `status 非 413 时必须否决: ${failure.message}`,
    );
  }
  // status === 413 时即使文本毫无线索也必须命中。
  assert.equal(
    isPayloadTooLarge({ status: 413, code: 'INVALID_REQUEST', message: 'whatever' }),
    true,
  );
  // 没给 status 时仍走文本识别（pi-ai 主路径）。
  assert.equal(
    isPayloadTooLarge({ code: 'INVALID_REQUEST', message: '413: Request payload is too large' }),
    true,
  );
});

check('413 识别：不误伤上下文窗口超限与其他错误', () => {
  const cases = [
    { message: 'context window exceeded', code: 'CONTEXT_WINDOW_EXCEEDED' },
    { message: 'This model maximum context length is 128000 tokens', code: 'CONTEXT_WINDOW_EXCEEDED' },
    { message: 'too many tokens', code: 'INVALID_REQUEST' },
    { message: 'rate limit', code: 'RATE_LIMIT' },
    { message: 'Connection error.', code: 'TRANSPORT' },
    { message: 'pi-ai stream idle timeout after 300000ms', code: 'TIMEOUT' },
    // 其它 HTTP 状态码不应被误认为 413。
    { message: 'bad request', code: 'INVALID_REQUEST', status: 400 },
    { message: 'server error', code: 'SERVER', status: 500 },
  ];
  for (const failure of cases) {
    assert.equal(isPayloadTooLarge(failure), false, `不应命中: ${failure.message}`);
  }
  assert.equal(isPayloadTooLarge(undefined), false);
  assert.equal(isPayloadTooLarge(null), false);
});

check('幂等：已 offload 的图不会被二次选中', () => {
  const msg = {
    content: [
      { type: 'image', attachment: makeRef('x', 1), offloaded: true },
      makeImage('y', 2),
    ],
  };
  const session = makeSession([[400, 'user/message', msg]]);
  const found = scanRetainedImages(session);
  assert.equal(found.length, 1);
  assert.equal(found[0].imageIndex, 1);
});

check('空会话 / 无图会话安全返回', () => {
  assert.deepEqual(scanRetainedImages(makeSession([])), []);
  const noImages = makeSession([
    [500, 'user/message', { content: [{ type: 'text', text: '纯文本' }] }],
    [501, 'tool/result', { content: [{ type: 'text', text: '结果' }] }],
  ]);
  assert.deepEqual(scanRetainedImages(noImages), []);
  assert.deepEqual(pickTargets([], 5), []);
});

// ---------------------------- 主开关（enabled）-----------------------------

/** 造一个只记录挂载行为的假 ctx。 */
function makeFakeCtx(projections = []) {
  const listeners = [];
  const registered = [];
  const logs = [];
  return {
    listeners,
    registered,
    logs,
    sessions: {
      messageProjections: projections,
      registerMessageProjection: (projection) => {
        registered.push(projection);
        return () => {};
      },
    },
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
    },
    on: (eventName, handler) => {
      listeners.push([eventName, handler]);
      return () => {};
    },
  };
}

check('enabled 默认开启', () => {
  assert.equal(resolveConfig({}).enabled, true);
  assert.equal(resolveConfig(undefined).enabled, true);
  assert.equal(resolveConfig({ enabled: true }).enabled, true);
  assert.equal(resolveConfig({ enabled: 'true' }).enabled, true, '非 false 的真值都算开');
});

check('enabled=false：不挂任何监听、不注册解释器（完全等于没装）', () => {
  const fake = makeFakeCtx();
  apply(fake, { enabled: false });
  assert.equal(fake.listeners.length, 0, '不应挂 agent/request-error 监听');
  assert.equal(fake.registered.length, 0, '不应注册任何投影');
  assert.ok(
    fake.logs.some(([, message]) => /enabled=false/u.test(message)),
    '应留下停用日志便于排查',
  );
});

check('enabled=true：挂上 413 监听', () => {
  const fake = makeFakeCtx([{ type: 'image/offload', project: () => {} }]);
  apply(fake, {});
  assert.equal(fake.listeners.length, 1);
  assert.equal(fake.listeners[0][0], 'agent/request-error');
});

// ------------------- 解释器缺席时的 fail-closed 行为 ----------------------

check('内置解释器缺席：不注册兜底，且不挂监听（fail-closed）', () => {
  const fake = makeFakeCtx([]); // 空 projections，模拟没有 image-offload 插件
  apply(fake, {});
  assert.equal(fake.registered.length, 0, '绝不能抢注解释器（会让官方插件抛 already registered）');
  assert.equal(fake.listeners.length, 0, '没有解释器就别挂监听：写了也解释不了，不该假装能工作');
  assert.ok(
    fake.logs.some(([, message]) => /未检测到 image\/offload 解释器/u.test(message)),
    '应留下明确 warn，说明为何不工作',
  );
});

check('内置解释器存在：正常挂监听、不重复注册', () => {
  const fake = makeFakeCtx([{ type: 'image/offload', project: () => {} }]);
  apply(fake, {});
  assert.equal(fake.registered.length, 0, '内置已在，插件不该再注册');
  assert.equal(fake.listeners.length, 1);
});

// 端到端：用假 agent 走一遍 413 处理路径，验证真的写入 image/offload 并返回 retry。
//
// 注意：重试计数按 agent 实例存在 WeakMap 里，所以同一轮对话必须复用同一个
// agent 对象 —— 这正好和真实运行时一致（一个会话一个 agent）。
function makeAgent(session, appended) {
  return {
    session: {
      ...session,
      append: (type, data) => {
        appended.push({ type, data });
        return { seq: 999 };
      },
    },
  };
}

function runHandler(fake, { failure, agent, turn = 1, step = 1 }) {
  const handler = fake.listeners.find(([eventName]) => eventName === 'agent/request-error')?.[1];
  assert.ok(handler, 'handler 必须存在');
  return handler({ agent, turn, step, failure, signal: { aborted: false } }, () => 'NEXT');
}

check('端到端：413 触发 → 写入 image/offload → 返回 retry', () => {
  const image = makeImage('a', 1024);
  const session = makeSession([[10, 'user/message', { content: [image] }]]);
  const fake = makeFakeCtx([{ type: 'image/offload', project: () => {} }]);
  apply(fake, {});

  const appended = [];
  const agent = makeAgent(session, appended);
  const outcome = runHandler(fake, {
    failure: { message: '413: {"message":"Request payload is too large"}', code: 'INVALID_REQUEST' },
    agent,
  });
  assert.deepEqual(outcome, { kind: 'retry' }, '应要求重试');
  assert.equal(appended.length, 1);
  assert.equal(appended[0].type, 'image/offload');
  assert.deepEqual(appended[0].data.targets, [{ seq: 10, imageIndexes: [0] }]);
});

check('端到端：非 413 错误原样放行，不写事件', () => {
  const image = makeImage('a', 1024);
  const session = makeSession([[10, 'user/message', { content: [image] }]]);
  const fake = makeFakeCtx([{ type: 'image/offload', project: () => {} }]);
  apply(fake, {});

  const appended = [];
  const agent = makeAgent(session, appended);
  for (const failure of [
    { message: 'Connection error.', code: 'TRANSPORT' },
    { message: 'rate limit exceeded', code: 'RATE_LIMIT' },
    { message: 'context window exceeded', code: 'CONTEXT_WINDOW_EXCEEDED' },
  ]) {
    const outcome = runHandler(fake, { failure, agent });
    assert.equal(outcome, 'NEXT', `${failure.code} 应交回下游`);
    assert.equal(appended.length, 0, `${failure.code} 不该写 offload`);
  }
});

check('端到端：enabled=false 时 413 也原样失败（回到默认行为）', () => {
  const image = makeImage('a', 1024);
  const session = makeSession([[10, 'user/message', { content: [image] }]]);
  const fake = makeFakeCtx([{ type: 'image/offload', project: () => {} }]);
  apply(fake, { enabled: false });

  // 没挂监听 → 没有 handler；等价于框架里根本没这个恢复点。
  const handler = fake.listeners.find(([eventName]) => eventName === 'agent/request-error');
  assert.equal(handler, undefined, 'enabled=false 不应挂监听，413 直接按原生失败');
});

check('端到端：无图可移时放行并 warn（纯文本撑爆的场景）', () => {
  const session = makeSession([
    [10, 'user/message', { content: [{ type: 'text', text: '很长很长的纯文本' }] }],
  ]);
  const fake = makeFakeCtx([{ type: 'image/offload', project: () => {} }]);
  apply(fake, {});

  const appended = [];
  const agent = makeAgent(session, appended);
  const outcome = runHandler(fake, {
    failure: { message: 'payload too large', code: 'INVALID_REQUEST' },
    agent,
  });
  assert.equal(outcome, 'NEXT');
  assert.equal(appended.length, 0, '没图可移，不该写空 offload');
  assert.ok(
    fake.logs.some(([level]) => level === 'warn'),
    '应 warn 说明这类体积问题本插件帮不上忙',
  );
});

check('端到端：本回合恢复次数耗尽后放行（防止和上游无限转圈）', () => {
  const session = makeSession([[10, 'user/message', { content: [makeImage('a', 1024)] }]]);
  const fake = makeFakeCtx([{ type: 'image/offload', project: () => {} }]);
  apply(fake, { maxRecoveriesPerTurn: 2 });

  const appended = [];
  const agent = makeAgent(session, appended); // 同一 agent = 同一轮对话
  const failure = { message: 'payload too large', code: 'INVALID_REQUEST' };

  assert.deepEqual(runHandler(fake, { failure, agent }), { kind: 'retry' }, '第 1 次应重试');
  assert.deepEqual(runHandler(fake, { failure, agent }), { kind: 'retry' }, '第 2 次仍重试');
  assert.equal(runHandler(fake, { failure, agent }), 'NEXT', '第 3 次超预算后交回原错误');
});

check('端到端：跨 step 不重置预算（P0 关键：堵住回读循环）', () => {
  const session = makeSession([[10, 'user/message', { content: [makeImage('a', 1024)] }]]);
  const fake = makeFakeCtx([{ type: 'image/offload', project: () => {} }]);
  apply(fake, { maxRecoveriesPerTurn: 2 });

  const appended = [];
  const agent = makeAgent(session, appended);
  const failure = { message: 'payload too large', code: 'INVALID_REQUEST' };

  // 同一 turn 内换 step —— 旧实现按 `${turn}/${step}` 计数，这里会重新计满，
  // 从而使「回读 → 超限 → 再卸载」的跨 step 循环完全不受限。
  assert.deepEqual(runHandler(fake, { failure, agent, step: 1 }), { kind: 'retry' });
  assert.deepEqual(runHandler(fake, { failure, agent, step: 2 }), { kind: 'retry' });
  assert.equal(
    runHandler(fake, { failure, agent, step: 3 }),
    'NEXT',
    '同一回合换 step 不得重置预算',
  );
});

check('端到端：进入新回合后预算重置', () => {
  const session = makeSession([[10, 'user/message', { content: [makeImage('a', 1024)] }]]);
  const fake = makeFakeCtx([{ type: 'image/offload', project: () => {} }]);
  apply(fake, { maxRecoveriesPerTurn: 1 });

  const appended = [];
  const agent = makeAgent(session, appended);
  const failure = { message: 'payload too large', code: 'INVALID_REQUEST' };

  assert.deepEqual(runHandler(fake, { failure, agent, turn: 1 }), { kind: 'retry' });
  assert.equal(runHandler(fake, { failure, agent, turn: 1 }), 'NEXT', '同一回合超预算');
  assert.deepEqual(
    runHandler(fake, { failure, agent, turn: 2 }),
    { kind: 'retry' },
    '新回合应重新获得预算',
  );
});

check('端到端：参数错误（裸 INVALID_REQUEST）绝不写 offload', () => {
  const session = makeSession([[10, 'user/message', { content: [makeImage('a', 1024)] }]]);
  const fake = makeFakeCtx([{ type: 'image/offload', project: () => {} }]);
  apply(fake, {});

  const appended = [];
  const agent = makeAgent(session, appended);

  // 这是发布前必过的安全回归：误判会造成**不可逆**的图片卸载。
  for (const failure of [
    { message: 'Invalid request parameters', code: 'INVALID_REQUEST' },
    { message: 'unsupported parameter: temperature', code: 'INVALID_REQUEST' },
    { message: 'Image does not match the provided media type image/jpeg', code: 'INVALID_REQUEST' },
  ]) {
    assert.equal(runHandler(fake, { failure, agent }), 'NEXT', '应交回下游');
  }
  assert.equal(appended.length, 0, '一次 offload 都不该写');
});

check('动态提示：未卸载时为空串，卸载后返回固定文本', () => {
  const session = makeSession([[10, 'user/message', { content: [makeImage('a', 1024)] }]]);
  const contexts = [];
  const fake = makeFakeCtx([{ type: 'image/offload', project: () => {} }]);
  // 补上 systemPrompt 服务，让 ctx.inject 能跑起来
  fake.systemPrompt = {
    context: (entry) => {
      contexts.push(entry);
      return () => {};
    },
    getContextOrder: () => 9000,
  };
  fake.inject = (deps, fn) => {
    fake.injected = deps;
    fn(fake);
  };
  apply(fake, {});

  assert.deepEqual(fake.injected, ['systemPrompt'], '应向 systemPrompt 注入');
  assert.equal(contexts.length, 1, '应注册一个 context 贡献');
  const entry = contexts[0];
  assert.equal(typeof entry.text, 'function', 'text 应为函数以便动态求值');

  const appended = [];
  const agent = makeAgent(session, appended);

  // 卸载前：空串（DSH 不会为空文本新增快照）
  assert.equal(entry.text({ agent }), '', '未发生卸载时必须是空串');

  runHandler(fake, {
    failure: { message: 'payload too large', code: 'INVALID_REQUEST' },
    agent,
  });

  const text = entry.text({ agent });
  assert.ok(text.length > 0, '卸载后应有提示');
  assert.ok(/一次只回读一张/u.test(text), '应包含「一次只读一张」的引导');
  assert.ok(/read_image/u.test(text), '应提到回读工具');
  // 不得错误归因：提示的激活状态也可能从官方主动卸载的事件重建，那时原因不是 413。
  assert.ok(!/网关上限|payload too large|413/u.test(text), '不得把原因归给网关超限');
  // 不得承诺一定能回读：拿不到可读路径时占位符只给附件身份。
  assert.ok(/不能保证能够重新读取/u.test(text), '应保留「不保证可回读」的限定');
  // 固定文本：不含任何可变数字，避免每次变化都追加一份新快照
  assert.ok(!/\d+\s*张/u.test(text), '不得包含可变计数（会导致快照堆积）');

  // 再次调用必须逐字一致 —— 否则每次都会追加新快照
  assert.equal(entry.text({ agent }), text, '文本必须稳定');
});

check('动态提示：notice=false 时不注册 context', () => {
  const fake = makeFakeCtx([{ type: 'image/offload', project: () => {} }]);
  fake.systemPrompt = { context: () => () => {}, getContextOrder: () => 9000 };
  fake.inject = (deps, fn) => fn(fake);
  const contexts = [];
  fake.systemPrompt.context = (entry) => {
    contexts.push(entry);
    return () => {};
  };
  apply(fake, { notice: false });
  assert.equal(contexts.length, 0, 'notice=false 时不应注册提示');
  assert.equal(fake.listeners.length, 1, '但 413 监听仍应挂上');
});

check('动态提示：恢复/fork 场景能从历史 image/offload 事件重建激活状态', () => {
  // 关键缺陷回归：内存 WeakMap 在「恢复持久化会话 / fork / 插件晚加载」时是空的，
  // 但历史里的 image/offload 事件还在。若不回扫重建，图片仍处于卸载状态，
  // 模型却收不到引导。官方 RuntimeContextProjection 正是靠回扫历史恢复状态。
  const contexts = [];
  const fake = makeFakeCtx([{ type: 'image/offload', project: () => {} }]);
  fake.systemPrompt = {
    context: (entry) => {
      contexts.push(entry);
      return () => {};
    },
    getContextOrder: () => 9000,
  };
  fake.inject = (deps, fn) => fn(fake);
  apply(fake, {});

  const entry = contexts[0];

  // 构造一个「历史里已有 image/offload，但本进程从未处理过 413」的会话。
  // targets 用**合法**形状（非空、seq 是 surface 节点）：官方 projection 会拒绝
  // 空 targets，用非法样本只能测到「扫到了事件类型」，证明不了真实历史可重放。
  const events = new Map([
    [0, { type: 'user/message', seq: 0 }],
    [1, { type: 'image/offload', seq: 1, data: { targets: [{ seq: 0, imageIndexes: [0] }] } }],
    [2, { type: 'assistant/message', seq: 2 }],
  ]);
  const restoredSession = {
    seq: 3,
    eventAt: (seq) => events.get(seq),
  };
  const restoredAgent = { session: restoredSession };

  const text = entry.text({ agent: restoredAgent });
  assert.ok(text.length > 0, '应能从历史事件重建出提示，而不是返回空串');
  assert.ok(/一次只回读一张/u.test(text));

  // 二次调用应命中缓存并保持一致。
  assert.equal(entry.text({ agent: restoredAgent }), text, '重复求值必须稳定');
});

check('动态提示：历史里没有 offload 事件时仍为空串', () => {
  const contexts = [];
  const fake = makeFakeCtx([{ type: 'image/offload', project: () => {} }]);
  fake.systemPrompt = {
    context: (entry) => {
      contexts.push(entry);
      return () => {};
    },
    getContextOrder: () => 9000,
  };
  fake.inject = (deps, fn) => fn(fake);
  apply(fake, {});

  const events = new Map([
    [0, { type: 'user/message', seq: 0 }],
    [1, { type: 'assistant/message', seq: 1 }],
  ]);
  const cleanAgent = { session: { seq: 2, eventAt: (seq) => events.get(seq) } };
  assert.equal(contexts[0].text({ agent: cleanAgent }), '', '干净会话必须是空串');
});

check('动态提示：历史扫描必须是真增量（不重复扫已检查区间）', () => {
  // 回归用例：早期实现的 checkedUpTo 只改了循环起点，循环仍一路降到 0，
  // 等于每次求值都全量重扫。对以超长会话为主要场景的插件，这是实打实的浪费。
  const contexts = [];
  const fake = makeFakeCtx([{ type: 'image/offload', project: () => {} }]);
  fake.systemPrompt = {
    context: (entry) => {
      contexts.push(entry);
      return () => {};
    },
    getContextOrder: () => 9000,
  };
  fake.inject = (deps, fn) => fn(fake);
  apply(fake, {});

  const calls = [];
  let seqTotal = 1000;
  const events = new Map();
  for (let i = 0; i < 1000; i += 1) events.set(i, { type: 'user/message', seq: i });
  const session = {
    get seq() {
      return seqTotal;
    },
    eventAt: (seq) => {
      calls.push(seq);
      return events.get(seq);
    },
  };
  const agent = { session };
  const entry = contexts[0];

  calls.length = 0;
  entry.text({ agent });
  assert.equal(calls.length, 1000, '首次求值需要扫全量');

  calls.length = 0;
  entry.text({ agent });
  assert.equal(calls.length, 0, '无新增事件时必须一次都不扫');

  seqTotal = 1001;
  events.set(1000, { type: 'user/message', seq: 1000 });
  calls.length = 0;
  entry.text({ agent });
  assert.equal(calls.length, 1, '新增 1 条时只能扫这 1 条（倒序 → 先看最新的）');

  // 命中 offload 之后永久短路。
  seqTotal = 1002;
  events.set(1001, { type: 'image/offload', seq: 1001, data: { targets: [{ seq: 1000, imageIndexes: [0] }] } });
  calls.length = 0;
  const text = entry.text({ agent });
  assert.ok(text.length > 0, '命中后应激活提示');
  assert.equal(calls.length, 1, '命中那一条时只扫 1 次');

  calls.length = 0;
  entry.text({ agent });
  assert.equal(calls.length, 0, '已确认存在后必须短路，不再扫描');
});

console.log(`\n全部 ${passed} 组用例通过`);
