/**
 * 在本地寻找 DSH 安装里的 `image/offload` projection，用于跨实现交叉验证。
 *
 * 这个测试想验证的是「插件算出的 imageIndex 与官方 projection 逐位对齐」。
 * 那要求真的把官方实现加载起来，但不该把某台机器的绝对路径写进公开仓库。
 * 于是按以下顺序探测，全都不命中就返回 null，让调用方跳过这项（而非失败）：
 *
 * 1. 环境变量 `DSH_HOME` / `DSH_CHECKOUT` 指向的目录
 * 2. `npm root -g` 返回的全局 node_modules
 * 3. 常见默认位置的兜底猜测
 *
 * 项目内不做额外依赖，只用 Node 内置能力。
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 官方包里的 projection 相对路径。 */
const PROJECTION_RELATIVE = join(
  '@deepseek-ai',
  'dsh',
  'node_modules',
  '@deepseek-ai',
  'dsh-compaction-image-offload',
  'lib',
  'types',
  'projection.js',
);

/** 候选根目录，按可信度从高到低。 */
function candidateRoots() {
  const roots = [];

  const explicit = process.env.DSH_CHECKOUT;
  if (explicit) roots.push(explicit);

  const home = process.env.DSH_HOME;
  if (home) roots.push(home);

  // 全局 npm 前缀（Windows: %APPDATA%\npm\node_modules）
  // Windows 上直接调 npm.cmd，避免 shell:true 传参（会触发 DEP0190）。
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) {
      const npmCmd = join(appData, 'npm', 'npm.cmd');
      if (existsSync(npmCmd)) {
        try {
          const out = execFileSync(npmCmd, ['root', '-g'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 10_000,
          }).trim();
          if (out) roots.push(out);
        } catch {
          /* 忽略，走下方的默认位置兜底 */
        }
      }
      roots.push(join(appData, 'npm', 'node_modules'));
    }
  } else {
    try {
      const out = execFileSync('npm', ['root', '-g'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
      }).trim();
      if (out) roots.push(out);
    } catch {
      /* 忽略 */
    }
    roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules');
  }

  return roots;
}

/**
 * 解析官方 projection 的 file:// URL。
 * @returns {string|null} 可 import 的 URL，或 null 表示本机找不到。
 */
export function resolveBuiltinProjectionUrl() {
  for (const root of candidateRoots()) {
    if (!root) continue;
    const full = join(root, PROJECTION_RELATIVE);
    if (existsSync(full)) return pathToFileURL(full).href;
  }
  return null;
}

/**
 * 尝试加载官方 projection。
 * @returns {Promise<{ imageOffloadProjection: object }|null>} 失败或缺席时为 null。
 */
export async function loadBuiltinProjection() {
  const url = resolveBuiltinProjectionUrl();
  if (url === null) return null;
  try {
    const module = await import(url);
    if (module?.imageOffloadProjection === undefined) return null;
    return { imageOffloadProjection: module.imageOffloadProjection, url };
  } catch {
    return null;
  }
}
