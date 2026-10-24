/**
 * 用真实死档数据做端到端干跑：解压一个 DSH 会话日志，重建 surface，喂给插件的
 * 真实实现，验证它算出的 targets 能让请求瘦下来、且能被官方 projection 正确应用。
 *
 * 用法：
 *   node test/dead-session-dryrun.mjs <session.v4.jsonl.zstd 路径>
 *   node test/dead-session-dryrun.mjs            # 自动搜 ~/.dsh/sessions 下图片最多的会话
 *
 * 这是一个**本地诊断工具**，不是 CI 用例：它需要你机器上真有一个吃过 413 的会话。
 * 找不到会话或找不到官方 projection 时，会说明原因并以 0 退出（跳过而非失败）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { pickTargets, planOffloadCount, scanRetainedImages } from '../lib/index.js';
import { loadBuiltinProjection } from './builtin-projection.mjs';

/** 解压分帧 zstd（DSH 每批事件一个 frame）。 */
function loadEvents(file) {
  const buf = fs.readFileSync(file);
  const offsets = [];
  for (let i = 0; i < buf.length - 3; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
      offsets.push(i);
    }
  }
  let out = Buffer.alloc(0);
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try {
      out = Buffer.concat([out, zlib.zstdDecompressSync(buf.subarray(start, end))]);
    } catch {
      /* 末尾未完成的帧忽略 */
    }
  }
  return out
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** 递归找出所有 session.v4.jsonl.zstd。 */
function findSessionFiles(root, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) findSessionFiles(full, found);
    else if (entry.name === 'session.v4.jsonl.zstd') found.push(full);
  }
  return found;
}

/** 挑一个图片总量最大的会话，作为最有说服力的样本。 */
function pickRichestSession(files) {
  let best = null;
  for (const file of files) {
    try {
      const events = loadEvents(file);
      let images = 0;
      let bytes = 0;
      for (const event of events) {
        let content = null;
        if (event.type === 'user/message') content = event.data?.content;
        if (event.type === 'tool/result') {
          content = event.data?.message?.content ?? event.data?.content;
        }
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block?.type === 'image') {
            images += 1;
            bytes += block.attachment?.bytes ?? 0;
          }
        }
      }
      if (best === null || bytes > best.bytes) best = { file, events, images, bytes };
    } catch {
      /* 跳过读不了的会话 */
    }
  }
  return best;
}

const target = process.argv[2];

let sessionFile = target ?? null;
if (sessionFile === null) {
  const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const sessionsRoot = path.join(dshHome, 'sessions');
  if (!fs.existsSync(sessionsRoot)) {
    console.log(`跳过：未找到 ${sessionsRoot}（可用参数直接指定会话文件）`);
    process.exit(0);
  }
  const best = pickRichestSession(findSessionFiles(sessionsRoot));
  if (best === null) {
    console.log('跳过：没有可解析的会话文件');
    process.exit(0);
  }
  sessionFile = best.file;
  console.log(`自动选中图片最多的会话（${best.images} 张 / ${(best.bytes / 1048576).toFixed(2)} MiB）：`);
  console.log(`  ${sessionFile}\n`);
}

if (!fs.existsSync(sessionFile)) {
  console.error(`✗ 会话文件不存在: ${sessionFile}`);
  process.exit(1);
}

const builtin = await loadBuiltinProjection();
if (builtin === null) {
  console.log('跳过：本机未找到官方 @deepseek-ai/dsh，无法做交叉验证');
  process.exit(0);
}
const { imageOffloadProjection } = builtin;

const events = loadEvents(sessionFile);
console.log(`读到 ${events.length} 条事件`);

// ---- 重建 surface：只保留 message-producing 事件（等价于真实 surface）------
const SURFACE_TYPES = new Set([
  'user/message',
  'tool/result',
  'system/message',
  'developer/message',
  'assistant/message',
]);
const surfaceEvents = events.filter((event) => SURFACE_TYPES.has(event.type));

// 官方 projection 用 `events[seq - baseSeq]` 直接索引整个日志，且日志第 0 条是
// session header（无 seq），所以这里建一个以 seq 为下标的稠密数组。
const bySeqArray = [];
for (const event of events) {
  if (event.seq === undefined) continue;
  bySeqArray[event.seq] = event;
}
const baseSeq = 0;

const session = {
  surface: { nodes: surfaceEvents.map((event) => event.seq) },
  eventAt: (seq) => bySeqArray[seq],
  deriveEventMessage: (event) => {
    switch (event.type) {
      case 'user/message':
        return event.data;
      case 'system/message':
      case 'developer/message':
      case 'assistant/message':
        return event.data.message.content.length === 0 ? null : event.data.message;
      case 'tool/result':
        return event.data.message;
      default:
        return null;
    }
  },
};

const retained = scanRetainedImages(session);
const totalBytes = retained.reduce((sum, entry) => sum + entry.bytes, 0);
console.log(`\n未 offload 的图片: ${retained.length} 张, ${(totalBytes / 1048576).toFixed(2)} MiB`);

if (retained.length === 0) {
  console.log('该会话没有未 offload 的图片，无需处理。');
  process.exit(0);
}

// ---- 干跑：模拟连续 413 后的逐轮收敛 --------------------------------------
const config = { offloadRatio: 0.5, maxOffloadPerRetry: 12, maxRetriesPerStep: 6 };

// 用真实的 offloaded 标记做逐轮模拟：每轮把选中的标记进一个 set，再重新扫描。
const offloadedKeys = new Set();

/** 找到某个 image block 在其消息里的 image 序号。 */
function indexOfImage(message, target) {
  let index = 0;
  for (const block of message.content) {
    if (block.type === 'image') {
      if (block === target) return index;
      index += 1;
    }
  }
  return -1;
}

const roundSession = {
  surface: session.surface,
  eventAt: session.eventAt,
  deriveEventMessage: (event) => {
    const message = session.deriveEventMessage(event);
    if (message === null) return null;
    const content = message.content.map((block) =>
      block.type === 'image' && offloadedKeys.has(`${event.seq}#${indexOfImage(message, block)}`)
        ? { ...block, offloaded: true }
        : block,
    );
    return { ...message, content };
  },
};

let round = 0;
const trace = [];
let converged = false;

while (round < config.maxRetriesPerStep) {
  const still = scanRetainedImages(roundSession);
  if (still.length === 0) {
    converged = true;
    break;
  }
  const count = planOffloadCount(still.length, config);
  const targets = pickTargets(still, count);

  // 关键验证：把 targets 喂给官方 projection，必须不抛错。
  const context = {
    nodes: session.surface.nodes,
    baseSeq,
    events: bySeqArray,
    messages: new Map(),
  };
  const projected = imageOffloadProjection.project(
    { type: 'image/offload', data: { targets } },
    context,
  );

  const moved = targets.reduce((sum, item) => sum + item.imageIndexes.length, 0);
  const movedBytes = still.slice(0, moved).reduce((sum, entry) => sum + entry.bytes, 0);
  trace.push(`${moved}张/${(movedBytes / 1048576).toFixed(1)}MiB`);
  round += 1;

  // 把这次投影结果记进已 offload 集合
  for (const [seq, message] of projected) {
    let index = 0;
    for (const block of message.content) {
      if (block.type !== 'image') continue;
      if (block.offloaded === true) offloadedKeys.add(`${seq}#${index}`);
      index += 1;
    }
  }
}

const left = scanRetainedImages(roundSession);
console.log(`\n收敛轨迹（每轮移出）: ${trace.join(' -> ')}`);
console.log(`轮数: ${round}（上限 ${config.maxRetriesPerStep}）`);
console.log(`剩余未 offload: ${left.length} 张`);

if (!converged) {
  console.error('✗ 未能在重试上限内收敛完');
  process.exit(1);
}
console.log('\n✓ 真实会话数据：插件可在重试上限内把图片全部转成本地路径占位文本');
console.log('✓ 每一轮的 targets 都被官方 projection 无异常接受');
