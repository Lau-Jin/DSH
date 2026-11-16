/**
 * dsh-session-index · 宿主半身（DSH bundle Host 入口）。
 *
 * 两件事：
 *
 *  1. **路径自解析**（原有）：MCP 那一行（@deepseek-ai/dsh-mcp-client）在 cordis 配置里
 *     必须是绝对路径才能 spawn，而插件页安装位置由 pnpm 决定，安装时没法回写一个已知的
 *     绝对路径。所以拆成两步：本文件由 bundle patch 的 insert 挂载，ESM 的 import.meta.url
 *     天然指向真实安装目录；再把 server.mjs 的绝对路径落到
 *     $DSH_HOME/session-index/server-path.txt，cordis.patch.yml 里 mcp-client 的 args
 *     用 `!!js` 读这个文件。宿主行排在 mcp-client 行之前，首次安装即可用。
 *
 *  2. **给面板供数**（新增）：注册 `session-index` 命令，面板通过
 *     `ctx.remote.commands.execute()` 取会话卡列表 / 搜索 / 单卡详情。
 *     浏览器半身读不了文件系统，这是它唯一的数据通道。
 *
 * 约束：这里绝不能抛错。加载顺序上它在 mcp-client 之前，抛错会影响整棵插件树，
 * 而它做的事（记路径、注册命令）失败了也不该拖累别人，所以全量 try/catch。
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

/* ---------------------------------------------------------------- 会话卡读取
 * 面板要的数据全在 cards.json 里：{ version, builtAt, cards: { [id]: card } }。
 * 这里每次调用都现读——130 KB 量级，比维护一份内存副本简单，也天然跟上自动重建。
 */
function loadCards(indexDir) {
  const file = path.join(indexDir, 'cards.json');
  if (!fs.existsSync(file)) {
    return { cards: [], builtAt: null, missing: true };
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const map = raw && typeof raw.cards === 'object' && raw.cards ? raw.cards : {};
  return { cards: Object.values(map), builtAt: raw.builtAt || null, missing: false };
}

/** 列表用的瘦身字段：卡片全文有几十 KB，面板列表不需要。 */
function summarize(card) {
  return {
    id: card.id,
    title: card.title || '',
    app: card.app || 'dsh',
    workspace: card.workspace || '',
    updatedAt: card.updatedAt || 0,
    recordCount: card.recordCount || 0,
    keywords: (card.keywords || []).slice(0, 12),
    digest: card.digest || '',
    questionCount: (card.questions || []).length,
    decisionCount: (card.decisions || []).length,
    pathCount: (card.paths || []).length,
    parentSession: card.parentSession || null,
  };
}

/** 简单打分：命中处越多越靠前，标题命中加倍。 */
function scoreCard(card, needle) {
  const q = needle.toLowerCase();
  if (!q) return 0;
  const hit = (text) => (String(text || '').toLowerCase().includes(q) ? 1 : 0);
  let score = 0;
  score += hit(card.title) * 6;
  score += hit(card.digest) * 3;
  score += (card.keywords || []).reduce((n, k) => n + hit(k) * 3, 0);
  score += (card.questions || []).reduce((n, k) => n + hit(k), 0);
  score += (card.decisions || []).reduce((n, k) => n + hit(k), 0);
  score += (card.paths || []).reduce((n, k) => n + hit(k), 0);
  score += (card.files || []).reduce((n, k) => n + hit(k), 0);
  return score;
}

/** 命令正文：list / search / card / status。返回可 JSON 化的对象。 */
function runQuery(line, indexDir) {
  const [verb = 'list', ...rest] = String(line || '').trim().split(/\s+/);
  const arg = rest.join(' ').trim();

  if (verb === 'status') {
    const { cards, builtAt, missing } = loadCards(indexDir);
    const byApp = {};
    for (const c of cards) byApp[c.app || 'dsh'] = (byApp[c.app || 'dsh'] || 0) + 1;
    return {
      ok: true,
      missing,
      indexDir,
      cardsFile: path.join(indexDir, 'cards.json'),
      builtAt,
      total: cards.length,
      byApp,
      memories: safeCount(path.join(indexDir, 'notes.json')),
      serverPath: (() => {
        try { return fs.readFileSync(path.join(indexDir, 'server-path.txt'), 'utf8').trim(); } catch { return null; }
      })(),
    };
  }

  const { cards, builtAt, missing } = loadCards(indexDir);
  if (missing) return { ok: false, error: '索引还没建好：' + path.join(indexDir, 'cards.json') };

  const byTime = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);

  if (verb === 'card') {
    const id = arg;
    const card = cards.find((c) => c.id === id);
    if (!card) return { ok: false, error: '没有这张卡：' + id };
    return { ok: true, card, builtAt };
  }

  if (verb === 'search') {
    if (!arg) return { ok: false, error: 'search 要带关键词' };
    const scored = cards
      .map((c) => ({ card: c, score: scoreCard(c, arg) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || byTime(a.card, b.card))
      .slice(0, 40);
    return { ok: true, query: arg, total: scored.length, items: scored.map((x) => ({ score: x.score, ...summarize(x.card) })), builtAt };
  }

  // 默认 list（含 `list 20`）
  const limit = Math.min(Math.max(Number.parseInt(arg, 10) || 30, 1), 200);
  const items = cards.sort(byTime).slice(0, limit).map(summarize);
  return { ok: true, total: cards.length, shown: items.length, items, builtAt };
}

function safeCount(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw)) return raw.length;
    return raw && typeof raw === 'object' ? Object.keys(raw).length : 0;
  } catch {
    return 0;
  }
}

/* ---------------------------------------------------------------- 命令注册
 * 面板走 `ctx.remote.commands.execute(sessionId, 'session-index list', [])`。
 * `commands` 服务可能在本插件 apply 之后才就位，所以拿不到就挂到 ready 上再试一次；
 * 绝不抛错——记路径那件事不能被它连累。
 */
function registerCommand(ctx, indexDir) {
  let commands = null;
  try { commands = ctx.commands || (typeof ctx.get === 'function' ? ctx.get('commands') : null); } catch { commands = null; }
  if (!commands || typeof commands.register !== 'function') return false;
  try {
    const dispose = commands.register({
      name: 'session-index',
      description: '读取本机会话索引：列出最近会话卡、按关键词搜索、读单张卡的结论/涉及路径/关键词，或看索引状态。面板「会话检索」就是用它取数的。',
      input: { hint: 'list [条数] | search <关键词> | card <会话id> | status' },
      recordInput: false,
      handler: async (invocation) => {
        try {
          const payload = runQuery(String(invocation && invocation.rawInput || ''), indexDir);
          // ok:false 是「查不到 / 索引没建好」这类业务失败：翻成 error，
          // 斜杠命令与面板拿到的都是人话，而不是一段成功结果里的 JSON。
          if (payload && payload.ok === false) return { kind: 'error', text: payload.error || 'query failed' };
          return { kind: 'success', text: JSON.stringify(payload) };
        } catch (err) {
          return { kind: 'error', text: JSON.stringify({ ok: false, error: (err && err.message) || String(err) }) };
        }
      },
    });
    if (typeof ctx.effect === 'function' && typeof dispose === 'function') ctx.effect(() => dispose, 'session-index: command');
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

    // 1) 记录 MCP 入口路径（原有职责）
    const serverFile = findServer();
    if (!serverFile) {
      console.warn('[session-index] 未找到 server.mjs，跳过路径记录：' + ROOT);
    } else {
      const { target, changed } = writeServerPath(indexDir, serverFile);
      if (changed) console.log('[session-index] 已记录 MCP 入口：' + serverFile + ' → ' + target);
    }

    // 2) 注册面板取数用的命令
    if (registerCommand(ctx, indexDir)) {
      console.log('[session-index] 已注册面板取数命令 session-index');
    } else if (ctx && typeof ctx.on === 'function') {
      ctx.on('ready', () => {
        try {
          if (registerCommand(ctx, indexDir)) console.log('[session-index] 已注册面板取数命令 session-index（ready 后）');
        } catch { /* 忽略 */ }
      });
    }
  } catch (err) {
    console.warn('[session-index] 宿主半身初始化失败（不影响 MCP 侧独立运行）：' + (err && err.message ? err.message : err));
  }
}

/** 供单测直接调用：命令正文与卡片读取。 */
export const __test = { runQuery, loadCards, summarize, scoreCard, resolveIndexDir };

export default { apply };
