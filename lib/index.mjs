/**
 * dsh-session-index · 宿主半身（DSH bundle Host 入口）。
 *
 * 存在的唯一理由：**路径自解析**。
 *
 * MCP 那一行（@deepseek-ai/dsh-mcp-client）在 cordis 配置里必须是绝对路径才能 spawn，
 * 而插件页安装位置由 pnpm 决定（profile/node_modules/dsh-session-index），安装时
 * 没法回写一个已知的绝对路径。所以拆成两步：
 *
 *   1. 本文件由 bundle patch 的 insert 挂载，ESM 的 import.meta.url 天然指向真实安装
 *      目录 —— 这是唯一 100% 可靠的路径来源；
 *   2. 把 server.mjs 的绝对路径落到 $DSH_HOME/session-index/server-path.txt，
 *      cordis.patch.yml 里 mcp-client 的 args 用 `!!js` 读这个文件。
 *
 * 因为宿主行排在 mcp-client 行之前，写路径发生在后者 spawn 之前，首次安装即可用。
 *
 * 约束：这里绝不能抛错。加载顺序上它在 mcp-client 之前，抛错会影响整棵插件树，
 * 而它做的事只是「记一个路径」——失败了也不该拖累别人，所以全量 try/catch。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本文件所在目录（lib/）。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 包根目录：lib/ 的上一级。 */
const ROOT = path.resolve(HERE, '..');

/**
 * server.mjs 的候选位置。正常安装只命中第一条；其余为开发期 link 安装、
 * 以及被手工搬到别处的兜底。
 */
const SERVER_CANDIDATES = [
  path.join(ROOT, 'server.mjs'),
  path.join(HERE, 'server.mjs'),
  path.join(ROOT, 'dist', 'server.mjs'),
];

function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 取第一个真实存在的 server.mjs；都没有则返回 null。 */
function findServer() {
  return SERVER_CANDIDATES.find((file) => {
    try {
      return fs.existsSync(file);
    } catch {
      return false;
    }
  }) || null;
}

/**
 * 把真实路径写成一行文本。内容没变就不写，避免每次启动都动盘、
 * 也避免无谓地触发下游的文件监听。
 */
function writeServerPath(indexDir, serverFile) {
  fs.mkdirSync(indexDir, { recursive: true });
  const target = path.join(indexDir, 'server-path.txt');
  let current = null;
  try {
    current = fs.readFileSync(target, 'utf8').trim();
  } catch {
    current = null;
  }
  if (current === serverFile) return { target, changed: false };
  fs.writeFileSync(target, serverFile + '\n', 'utf8');
  return { target, changed: true };
}

/**
 * Host 入口。cordis 会把 profile 里该行的 config 传进来（本插件不需要配置）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文
 */
export function apply(ctx) {
  try {
    const serverFile = findServer();
    if (!serverFile) {
      // 不抛错：提示一次即可，MCP 侧会用自己那套候选路径继续尝试。
      console.warn('[session-index] 未找到 server.mjs，跳过路径记录：' + ROOT);
      return;
    }
    const indexDir = process.env.SESSION_INDEX_DIR || path.join(resolveDshHome(), 'session-index');
    const { target, changed } = writeServerPath(indexDir, serverFile);
    if (changed) console.log('[session-index] 已记录 MCP 入口：' + serverFile + ' → ' + target);

    // ctx 可能提供 effect/logger，但没有也必须能跑——这里不依赖任何 ctx 能力。
    void ctx;
  } catch (err) {
    console.warn('[session-index] 宿主半身初始化失败（不影响 MCP 侧独立运行）：' + (err && err.message ? err.message : err));
  }
}

export default { apply };
