/**
 * dsh-session-index · 宿主半身（DSH bundle Host 入口）。
 *
 * 三件事：
 *
 *  1. **路径自解析**（原有）：MCP 那一行（@deepseek-ai/dsh-mcp-client）在 cordis 配置里
 *     必须是绝对路径才能 spawn，而插件页安装位置由 pnpm 决定，安装时没法回写一个已知的
 *     绝对路径。所以拆成两步：本文件由 bundle patch 的 insert 挂载，ESM 的 import.meta.url
 *     天然指向真实安装目录；再把 server.mjs 的绝对路径落到
 *     $DSH_HOME/session-index/server-path.txt，cordis.patch.yml 里 mcp-client 的 args
 *     用 `!!js` 读这个文件。宿主行排在 mcp-client 行之前，首次安装即可用。
 *
 *  2. **斜杠命令**（给人用）：注册 `session-index` 命令（`/session-index list 20`、
 *     `/session-index search 插件`、`/session-index card <id>`、`/session-index status`），
 *     走的是 `lib/panel-api.mjs` —— 与 MCP 工具、面板 HTTP 通道**同一套查询实现**，
 *     所以人敲的命令和 agent 搜到的结果口径一致。
 *
 *  3. **自诊断**（新增）：每次 apply 都会往 `$DSH_HOME/session-index/host-half.log`
 *     追加一行（加载时间、命令是否注册成功、失败原因）。这一行是排查
 *     「面板报『宿主半身没加载』」的唯一硬证据 —— 面板本身在浏览器里，看不到宿主状态。
 *
 * 约束：这里绝不能抛错。加载顺序上它在 mcp-client 之前，抛错会影响整棵插件树，
 * 而它做的事（记路径、注册命令）失败了也不该拖累别人，所以全量 try/catch。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runQuery } from './panel-api.mjs';

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

/** 索引目录：显式 env → $DSH_HOME/session-index。 */
function resolveIndexDir() {
  return process.env.SESSION_INDEX_DIR || path.join(resolveDshHome(), 'session-index');
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

/* ---------------------------------------------------------------- 自诊断日志
 * 面板在浏览器里，看不见宿主状态。「宿主半身没加载」这类提示要靠这个文件定位：
 * 有 apply 记录 = 宿主加载过；没有 = 这一行根本没被 DSH 加载（查 bundle 行名与安装目录）。
 */
function appendHostLog(indexDir, message) {
  try {
    fs.mkdirSync(indexDir, { recursive: true });
    fs.appendFileSync(path.join(indexDir, 'host-half.log'), `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    /* 写不进去也不影响功能 */
  }
}

/** 记忆条数：状态里顺带报一下，方便人知道 remember 存了多少条。 */
function safeCount(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw)) return raw.length;
    return raw && typeof raw === 'object' ? Object.keys(raw).length : 0;
  } catch {
    return 0;
  }
}

/** status 额外带两个宿主侧才有的字段（记忆条数、MCP 入口路径）。 */
function statusPayload(indexDir) {
  const payload = runQuery(indexDir, 'status');
  if (!payload || payload.ok !== true) return payload;
  return {
    ...payload,
    memories: safeCount(path.join(indexDir, 'notes.json')),
    serverPath: (() => {
      try { return fs.readFileSync(path.join(indexDir, 'server-path.txt'), 'utf8').trim(); } catch { return null; }
    })(),
    channel: 'command',
  };
}

/**
 * 命令正文：list / search / card / status。
 * 统一走 lib/panel-api.mjs —— 与 MCP 工具、面板 HTTP 通道同一套实现，
 * 所以人敲的命令、面板看到的列表、agent 搜到的结果，口径完全一致。
 */
function runCommandQuery(indexDir, line) {
  const verb = String(line || '').trim().split(/\s+/)[0] || 'list';
  if (verb === 'status') return statusPayload(indexDir);
  return runQuery(indexDir, line);
}
/* ---------------------------------------------------------------- 命令注册
 * 面板走 `ctx.remote.commands.execute(sessionId, 'session-index list', [])`。
 * `commands` 服务可能在本插件 apply 之后才就位，所以三条路都试：直接拿 → `ctx.inject`
 * 等它就位（DSH 自带的 command-* 就是这种写法）→ `ready` 兜底。
 * 绝不抛错——记路径那件事不能被它连累。
 */
function commandSpec(indexDir) {
  return {
    name: 'session-index',
    description: '读取本机会话索引：列出最近会话卡、按关键词搜索、读单张卡的结论/涉及路径/关键词，或看索引状态。与 MCP 工具同一套查询实现，口径一致。',
    input: { hint: 'list [条数] | search <关键词> | card <会话id> | status' },
    recordInput: false,
    handler: async (invocation) => {
      try {
        const payload = runCommandQuery(indexDir, String(invocation && invocation.rawInput || ''));
        // ok:false 是「查不到 / 索引没建好」这类业务失败：翻成 error，
        // 斜杠命令与面板拿到的都是人话，而不是一段成功结果里的 JSON。
        if (payload && payload.ok === false) return { kind: 'error', text: payload.error || 'query failed' };
        return { kind: 'success', text: JSON.stringify(payload) };
      } catch (err) {
        return { kind: 'error', text: JSON.stringify({ ok: false, error: (err && err.message) || String(err) }) };
      }
    },
  };
}

/**
 * 在一个 ctx / scope 上尝试注册一次。
 * @param {object} ctx 宿主上下文或 inject scope
 * @param {string} indexDir 索引目录
 * @param {{done: boolean}} state 注册状态（避免重复注册）
 * @returns {boolean} 这一次是否注册成功
 */
function registerOn(ctx, indexDir, state) {
  if (!ctx || state.done) return false;
  let commands = null;
  try { commands = ctx.commands || (typeof ctx.get === 'function' ? ctx.get('commands') : null); } catch { commands = null; }
  if (!commands || typeof commands.register !== 'function') return false;
  try {
    const dispose = commands.register(commandSpec(indexDir));
    if (typeof ctx.effect === 'function' && typeof dispose === 'function') ctx.effect(() => dispose, 'session-index: command');
    state.done = true;
    console.log('[session-index] 已注册面板取数命令 session-index');
    return true;
  } catch (err) {
    console.warn('[session-index] 命令注册失败（面板不可用，MCP 不受影响）：' + (err && err.message ? err.message : err));
    return false;
  }
}

/**
 * Host 入口。cordis 会把 profile 里该行的 config 传进来（本插件不需要配置）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文
 */
export function apply(ctx) {
  try {
    const indexDir = resolveIndexDir();
    appendHostLog(indexDir, 'apply');

    // 1) 记录 MCP 入口路径（原有职责）
    const serverFile = findServer();
    if (!serverFile) {
      appendHostLog(indexDir, 'server.mjs 未找到：' + ROOT);
      console.warn('[session-index] 未找到 server.mjs，跳过路径记录：' + ROOT);
    } else {
      const { target, changed } = writeServerPath(indexDir, serverFile);
      if (changed) console.log('[session-index] 已记录 MCP 入口：' + serverFile + ' → ' + target);
      appendHostLog(indexDir, 'server=' + serverFile);
    }

    // 2) 注册斜杠命令（commands 服务晚到时补挂）
    const state = { done: false };
    const registerOrFail = () => {
      if (registerOn(ctx, indexDir, state)) {
        appendHostLog(indexDir, 'command registered');
        return true;
      }
      appendHostLog(indexDir, 'commands 服务不可用，等它就位');
      return false;
    };
    if (!registerOrFail()) {
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['commands'], (scope) => {
            try { registerOn(scope, indexDir, state) && appendHostLog(indexDir, 'command registered（inject）'); } catch { /* 忽略 */ }
          });
        }
      } catch { /* 忽略 */ }
      try {
        if (!state.done && typeof ctx.on === 'function') {
          ctx.on('ready', () => {
            try { registerOn(ctx, indexDir, state) && appendHostLog(indexDir, 'command registered（ready）'); } catch { /* 忽略 */ }
          });
        }
      } catch { /* 忽略 */ }
    }
  } catch (err) {
    appendHostLog(resolveIndexDir(), 'apply 失败：' + ((err && err.message) || err));
    console.warn('[session-index] 宿主半身初始化失败（不影响 MCP 侧独立运行）：' + (err && err.message ? err.message : err));
  }
}

/** 供单测直接调用：命令正文与卡片读取（都走 lib/panel-api.mjs）。 */
export const __test = {
  runQuery: runCommandQuery,
  runCommandQuery,
  statusPayload,
  resolveIndexDir,
  appendHostLog,
};

export default { apply };
