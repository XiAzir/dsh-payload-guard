/**
 * 真实 Agent Loop 集成测试（使用已发布的 npm 包，不依赖 DSH 源码 checkout）。
 *
 * 验证三条插件仓库无法用离线假件证明的契约：
 *   1. HTTP 400 → 会话里不得新增任何 image/offload 事件；
 *   2. HTTP 413 → 真的写入 image/offload、真的重试、后续请求图片被打上 offloaded；
 *   3. offload 落在真实 Session 日志里，回扫能定位到（提示重建的前提）。
 *
 * 仅 LlmAdapter 是脚本化的：不访问任何真实上游。
 * 运行方式见 test/integration/run.mjs（它准备隔离依赖目录并以绝对路径导入本文件）。
 */

import { Context } from '@deepseek-ai/cordis';
import * as offloadPlugin from '@deepseek-ai/dsh-compaction-image-offload';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit';

/** 由 run.mjs 注入，避免相对路径在隔离目录里失效。 */
const PAYLOAD_GUARD_ENTRY = process.env.PAYLOAD_GUARD_ENTRY;
const PROVIDER = 'scripted';

const finishError = (failure) => [{ type: 'finish', reason: { kind: 'error', failure } }];
const finishStop = (text = 'done') => [
  { type: 'content', block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
];

/**
 * 脚本化 adapter —— 必须真的继承 `LlmAdapter`。
 *
 * 只提供 `stream()` 的鸭子对象会在 `registration.adapter.prepareCall is not a function`
 * 处失败：路由注册要求完整的 adapter 契约（providerInfo / providerRetryPolicy /
 * resolveModel / prepareCall 等）。
 *
 * 每次请求记录图片块及其 offloaded 标记，用于断言官方投影是否生效。
 */
class ScriptedAdapter extends LlmAdapter {
  constructor(script) {
    super();
    this.script = script;
    this.requests = [];
    this.index = 0;
  }

  requestsRecorder() {
    return this.requests;
  }

  providerInfo(provider) {
    return { id: provider, name: 'scripted adapter' };
  }

  providerRetryPolicy() {
    // 返回 undefined = 使用默认策略；不在此层重试，让错误进入 agent/request-error。
    return undefined;
  }

  async listModels() {
    return [{ id: 'scripted-model', name: 'scripted model' }];
  }

  async resolveModel(provider, model) {
    // 字段要求来自 llm 的校验：provider 与 id 必须精确匹配入参，name 非空。
    return {
      provider,
      id: model,
      name: 'scripted model',
      contextWindow: 200000,
      maxTokens: 4096,
      input: ['text', 'image'],
    };
  }

  async prepareCall(provider, model) {
    const resolved = await this.resolveModel(provider, model);
    return { model: resolved, stream: (options) => this.stream(options) };
  }

  stream(options) {
    this.requests.push({
      images: (options.messages ?? []).flatMap((message) =>
        (message.content ?? [])
          .filter((block) => block.type === 'image')
          .map((block) => ({ offloaded: block.offloaded === true })),
      ),
    });
    const step = this.script[Math.min(this.index, this.script.length - 1)];
    this.index += 1;
    return (async function* emit() {
      yield* step;
    })();
  }
}

const attachmentRef = (bytes = 1024) => ({
  attachmentId: `sha256:${'a'.repeat(64)}`,
  mediaType: 'image/png',
  width: 64,
  height: 64,
  bytes,
  name: 'ref.png',
});

const imageMessage = (ref) => ({
  role: 'user',
  content: [
    { type: 'text', text: 'look at this' },
    { type: 'image', attachment: ref },
  ],
  source: { kind: 'user' },
});

let passed = 0;
let failed = 0;
async function test(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \u2713 ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  \u2717 ${label}`);
    console.log(`      ${error?.message ?? error}`);
  }
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** 装配真实运行时：依赖服务 + 官方 offload 插件 + 本插件 + AgentLoop + 脚本 adapter。 */
async function mount(adapter) {
  const ctx = new Context();
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true });
  await ctx.plugin(offloadPlugin);
  const payloadGuard = await import(PAYLOAD_GUARD_ENTRY);
  await ctx.plugin(payloadGuard);
  const harness = await mountAgentLoopTestHarness(ctx);
  ctx.llm.registerAdapter([PROVIDER], adapter);
  return { ctx, harness };
}

/**
 * 建 agent、送一条带图消息、等这一轮跑完。
 *
 * 关键：不能直接 `session.append` —— 那样消息进了日志但没有唤醒驱动，循环不会
 * 真正发请求。`agent.followup(input)` 会把消息塞进 next-turn 并唤醒 driver，
 * `await agent.whenIdle()` 等到这一轮（含 413 后的重试）彻底结束。
 */
async function runOnce(harness, id) {
  const agent = await harness.create(id, { provider: PROVIDER, model: 'scripted-model' });
  agent.followup(imageMessage(attachmentRef()));
  await agent.whenIdle();
  return agent;
}

console.log('payload-guard 真实 Agent Loop 集成测试\n');

// --- 场景 1：HTTP 400 不得产生任何 offload -------------------------------
await test('HTTP 400 → 会话中没有新增 image/offload 事件', async () => {
  const adapter = new ScriptedAdapter([
    finishError({
      message: 'HTTP 400: invalid field value "413"',
      code: 'INVALID_REQUEST',
      status: 400,
    }),
    finishStop(),
  ]);
  const { ctx, harness } = await mount(adapter);
  try {
    const agent = await runOnce(harness, 's-400');
    const offloads = agent.session.log.filter((event) => event.type === 'image/offload');
    assert(offloads.length === 0, `不应写 image/offload，实际写了 ${offloads.length} 条`);
    // 该失败确实发生过（否则断言无意义）
    assert(adapter.requests.length >= 1, '应至少发出过 1 次请求');
  } finally {
    await ctx.dispose?.();
  }
});

// --- 场景 2：HTTP 413 触发卸载并重试 --------------------------------------
await test('HTTP 413 → 写入 offload、发生重试、后续请求图片被标记', async () => {
  const adapter = new ScriptedAdapter([
    finishError({
      message: '413: {"message":"Request payload is too large"}',
      code: 'INVALID_REQUEST',
    }),
    finishStop(),
  ]);
  const { ctx, harness } = await mount(adapter);
  try {
    const agent = await runOnce(harness, 's-413');

    const offloads = agent.session.log.filter((event) => event.type === 'image/offload');
    assert(offloads.length >= 1, `应写入 image/offload，实际 ${offloads.length} 条`);

    assert(adapter.requests.length >= 2, `应至少发出 2 次请求（首次失败 + 重试），实际 ${adapter.requests.length}`);
    const second = adapter.requests[adapter.requests.length - 1];
    assert(second.images.length > 0, '后续请求仍应保留图片出现位置（只是标记 offloaded）');
    assert(
      second.images.some((image) => image.offloaded === true),
      '后续请求中的图片应已被官方投影标记 offloaded',
    );
  } finally {
    await ctx.dispose?.();
  }
});

// --- 场景 3：offload 落在真实日志里，回扫定位得到 -------------------------
await test('offload 事件落在真实 Session 日志 → 回扫可定位（提示重建前提）', async () => {
  const adapter = new ScriptedAdapter([
    finishError({ message: 'payload too large', code: 'INVALID_REQUEST' }),
    finishStop(),
  ]);
  const { ctx, harness } = await mount(adapter);
  try {
    const agent = await runOnce(harness, 's-restore');
    assert(
      agent.session.log.some((event) => event.type === 'image/offload'),
      '前置条件：应已产生 offload 事件',
    );
    assert(typeof agent.session.seq === 'number', 'session.seq 必须是数字');
    assert(typeof agent.session.eventAt === 'function', 'session.eventAt 必须可调用');

    let found = false;
    for (let seq = agent.session.seq - 1; seq >= 0; seq -= 1) {
      if (agent.session.eventAt(seq)?.type === 'image/offload') {
        found = true;
        break;
      }
    }
    assert(found, '回扫必须能在真实日志里找到 image/offload');
  } finally {
    await ctx.dispose?.();
  }
});

console.log(`\n通过 ${passed}，失败 ${failed}`);
process.exit(failed > 0 ? 1 : 0);
