/**
 * 真实 Agent Loop 集成测试的运行器。
 *
 * 设计目标：插件仓库本身保持**零 DSH 运行时依赖**（生产依赖里没有任何
 * `@deepseek-ai/dsh-*`），真实集成测试所需的包装在仓库外的隔离目录里。
 *
 * 用法：
 *   node test/integration/run.mjs
 *
 * 环境变量：
 *   DSH_TESTKIT_DEPS  隔离依赖目录（默认 <tmp>/dsh-payload-guard-itest）
 *   DSH_TESTKIT_VERSION  锁定的 DSH 版本（默认 0.2.1-rc.2）
 *   SKIP_INSTALL=1    复用已装好的依赖，跳过 npm install
 *
 * 为什么不在仓库里直接 npm install：
 * 这些包互相有大量 peer 依赖、必须版本一致；放进生产依赖会污染插件，让
 * 只想安装插件的用户被迫下载整套 DSH。隔离目录既保证版本可控，又不影响
 * 插件的干净安装。
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const SPEC = join(HERE, 'agent-loop.spec.mjs');
const ENTRY = join(REPO_ROOT, 'lib', 'index.js');

const VERSION = process.env.DSH_TESTKIT_VERSION ?? '0.2.1-rc.2';
// 目录名带上版本：否则切换 DSH_TESTKIT_VERSION 之后会复用上一个版本的依赖，
// 出现「以为验证了 rc.3、实际跑的是 rc.2」的假验证。
const DEPS_DIR =
  process.env.DSH_TESTKIT_DEPS ?? join(tmpdir(), `dsh-payload-guard-itest-${VERSION}`);

/** 集成测试直接用到、且必须版本一致的包。 */
const PACKAGES = [
  `@deepseek-ai/cordis@~4.0.5`,
  `@deepseek-ai/dsh-agent@${VERSION}`,
  `@deepseek-ai/dsh-agent-loop@${VERSION}`,
  `@deepseek-ai/dsh-agent-loop-testkit@${VERSION}`,
  `@deepseek-ai/dsh-llm@${VERSION}`,
  `@deepseek-ai/dsh-session@${VERSION}`,
  `@deepseek-ai/dsh-session-projection@${VERSION}`,
  `@deepseek-ai/dsh-system-prompt@${VERSION}`,
  `@deepseek-ai/dsh-tools@${VERSION}`,
  `@deepseek-ai/dsh-working-directory@${VERSION}`,
  `@deepseek-ai/dsh-fs-local@${VERSION}`,
  `@deepseek-ai/dsh-compaction-image-offload@${VERSION}`,
];

/** 读取已安装 testkit 的实际版本；缺失返回 undefined。 */
function installedVersion() {
  const marker = join(DEPS_DIR, 'node_modules', '@deepseek-ai', 'dsh-agent-loop-testkit');
  const manifest = join(marker, 'package.json');
  if (!existsSync(manifest)) return undefined;
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')).version;
  } catch {
    return undefined;
  }
}

function ensureDeps() {
  mkdirSync(DEPS_DIR, { recursive: true });
  const marker = join(DEPS_DIR, 'node_modules', '@deepseek-ai', 'dsh-agent-loop-testkit');
  const packageJson = join(DEPS_DIR, 'package.json');
  if (!existsSync(packageJson)) {
    writeFileSync(
      packageJson,
      JSON.stringify({ name: 'dsh-payload-guard-itest', private: true, type: 'module' }, null, 2),
    );
  }

  // 已装版本的核验优先于「目录存在」：目录存在不代表装的是目标版本。
  // 手动指定 DSH_TESTKIT_DEPS 时，这是唯一能发现版本错配的地方。
  const present = installedVersion();
  if (present !== undefined) {
    if (present !== VERSION) {
      throw new Error(
        `依赖目录里装的是 ${present}，但请求的是 ${VERSION}。`
          + `请删掉该目录重跑，或换一个 DSH_TESTKIT_DEPS：${DEPS_DIR}`,
      );
    }
    console.log(`复用已安装依赖 ${present}: ${DEPS_DIR}`);
    return;
  }

  console.log(`安装集成测试依赖 ${VERSION} 到 ${DEPS_DIR} …`);
  // Windows 上 execFileSync 直接跑 npm.cmd 会 EINVAL（.cmd 需要 shell 解析）；
  // 而 stdio 不能用 'inherit'（受限环境禁止子进程继承管道）。折中：
  // 用 shell:true + stdio:'ignore'，安装结果由版本核验判定。
  const installCommand = `npm install --no-audit --no-fund --loglevel=error ${PACKAGES.join(' ')}`;
  try {
    execSync(installCommand, { cwd: DEPS_DIR, stdio: 'ignore', shell: true });
  } catch (error) {
    if (installedVersion() === undefined) {
      throw new Error(
        `安装集成测试依赖失败（${error?.message ?? error}）。`
          + `可手动执行：cd "${DEPS_DIR}" && ${installCommand}`,
      );
    }
  }
  const after = installedVersion();
  if (after === undefined) {
    throw new Error(`安装后仍未找到 testkit；请手动在 ${DEPS_DIR} 执行 npm install。`);
  }
  console.log('依赖安装完成');
}

ensureDeps();

// 让 spec 里的裸包名解析到隔离目录：NODE_PATH 对 ESM 无效，
// 所以把 spec 复制进隔离目录（那里有 node_modules），再以绝对路径导入。
const { readFile, writeFile } = await import('node:fs/promises');
const runtimeSpec = join(DEPS_DIR, 'agent-loop.spec.mjs');
await writeFile(runtimeSpec, await readFile(SPEC, 'utf8'));

process.env.PAYLOAD_GUARD_ENTRY = pathToFileURL(ENTRY).href;

console.log(`运行: ${runtimeSpec}`);
console.log(`插件入口: ${process.env.PAYLOAD_GUARD_ENTRY}\n`);

await import(pathToFileURL(runtimeSpec).href);

// spec 自己 process.exit，这里不会继续。
