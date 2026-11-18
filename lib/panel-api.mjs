/**
 * 会话卡查询层 —— **面板与 MCP 工具共用的唯一实现**。
 *
 * 背景：会话检索有三条出口给同一份索引：
 *   1. MCP 工具（server.mjs）—— 给 agent 用；
 *   2. 宿主半身的 `session-index` 斜杠命令（lib/index.mjs）—— 给人用；
 *   3. 面板的本地只读 HTTP API（lib/http-api.mjs）—— 给侧栏面板用。
 *
 * 以前第 2、3 条各自写了一套朴素打分（子串命中），和第 1 条的排序口径不一致：
 * agent 搜「插件」和面板搜「插件」给出的顺序可能不同，人和机器对不上账。
 * 现在三条路都走这个模块，排序口径统一为 `matchQuery`（与 `session_index_brief`
 * 的主题模式完全一致）。
 *
 * 约束：
 * - 只读：只碰 cards.json，绝不写索引、绝不碰源会话文件；
 * - 零依赖：只用 Node 标准库；
 * - 不依赖 MCP 进程：宿主半身也能直接用（它没有 MCP 上下文）。
 */
import path from 'node:path';
import { loadCards } from './index-store.mjs';
import { matchQuery } from './cards.mjs';

const appOf = (card) => card?.app || 'dsh';

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * 列表用的瘦身卡片：只给画列表要用的字段（标题 / 摘要 / 关键词 / 计数）。
 * 结论、提问、涉及路径、文件、工具这些成串的数组**不进列表** ——
 * 60 张卡一起塞会把响应撑到几百 KB，点开详情（/api/card）才取全文。
 */
export function summarizeCard(card) {
  const list = (value, max) => (Array.isArray(value) ? value.slice(0, max) : []);
  return {
    id: card.id,
    app: appOf(card),
    title: String(card.title || ''),
    workspace: String(card.workspace || ''),
    updatedAt: card.updatedAt || 0,
    recordCount: card.recordCount || 0,
    digest: String(card.digest || ''),
    keywords: list(card.keywords, 12),
    questionCount: Array.isArray(card.questions) ? card.questions.length : 0,
    decisionCount: Array.isArray(card.decisions) ? card.decisions.length : 0,
    pathCount: Array.isArray(card.paths) ? card.paths.length : 0,
    parentSession: card.parentSession || null,
  };
}

/** 读 cards.json；缺失时给出可读的失败原因而不是抛异常。 */
function readCards(indexDir) {
  const file = path.join(indexDir, 'cards.json');
  const doc = loadCards(indexDir);
  const cards = Object.values(doc.cards || {});
  return { file, doc, cards, missing: cards.length === 0 && !doc.builtAt };
}

function scopeCards(cards, { app, workspace }) {
  const ws = typeof workspace === 'string' ? workspace.trim().toLowerCase() : '';
  return cards.filter((card) => {
    if (app && app !== 'all' && appOf(card) !== app) return false;
    if (ws && !String(card.workspace || '').toLowerCase().includes(ws)) return false;
    return true;
  });
}

/**
 * 最近会话列表。
 * @param {string} indexDir 索引目录
 * @param {{limit?: number, app?: string, workspace?: string}} [options]
 */
export function listCards(indexDir, options = {}) {
  const limit = clampInt(options.limit, 1, 200, 60);
  const { file, doc, cards, missing } = readCards(indexDir);
  if (missing) {
    return { ok: false, error: `索引还没建好：${file}`, indexDir, cardsFile: file, items: [], total: 0 };
  }
  const scoped = scopeCards(cards, options);
  const sorted = scoped.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return {
    ok: true,
    indexDir,
    cardsFile: file,
    builtAt: doc.builtAt || null,
    total: scoped.length,
    shown: Math.min(limit, sorted.length),
    items: sorted.slice(0, limit).map(summarizeCard),
  };
}

/**
 * 关键词搜索会话卡。排序与 MCP 的 `session_index_brief`（主题模式）一致。
 * @param {string} indexDir 索引目录
 * @param {{query?: string, limit?: number, app?: string, workspace?: string}} [options]
 */
export function searchCards(indexDir, options = {}) {
  const query = String(options.query || '').trim();
  if (!query) return { ok: false, error: 'search 要带关键词', items: [], total: 0 };
  const limit = clampInt(options.limit, 1, 100, 40);
  const { file, doc, cards, missing } = readCards(indexDir);
  if (missing) {
    return { ok: false, error: `索引还没建好：${file}`, indexDir, cardsFile: file, items: [], total: 0 };
  }
  const scoped = scopeCards(cards, options);
  // matchQuery 需要 cardsDoc 形态；app/workspace 过滤已在上面做过，这里只做排序。
  const rows = matchQuery({ cards: Object.fromEntries(scoped.map((c) => [c.id, c])) }, query, { limit });
  return {
    ok: true,
    indexDir,
    cardsFile: file,
    builtAt: doc.builtAt || null,
    query,
    total: rows.length,
    items: rows.map((row) => ({
      score: row.score,
      hitKeywords: row.hitKeywords || [],
      hitPaths: row.hitPaths || [],
      ...summarizeCard(row.card),
    })),
  };
}

/**
 * 单张卡的详情。
 * @param {string} indexDir 索引目录
 * @param {{id?: string}} [options]
 */
export function cardDetail(indexDir, options = {}) {
  const id = String(options.id || '').trim();
  if (!id) return { ok: false, error: 'card 要带会话 id' };
  const { file, doc, cards } = readCards(indexDir);
  const card = cards.find((c) => c.id === id);
  if (!card) return { ok: false, error: `没有这张卡：${id}`, cardsFile: file };
  return { ok: true, indexDir, cardsFile: file, builtAt: doc.builtAt || null, card };
}

/**
 * 索引状态：面板顶部的「N 个会话 · 索引更新于 …」就是它。
 * @param {string} indexDir 索引目录
 * @param {object} [extra] 额外信息（例如 MCP 进程侧的 autoIndex 快照）
 */
export function indexStatus(indexDir, extra = {}) {
  const { file, doc, cards, missing } = readCards(indexDir);
  const byApp = {};
  for (const card of cards) byApp[appOf(card)] = (byApp[appOf(card)] || 0) + 1;
  return {
    ok: true,
    indexDir,
    cardsFile: file,
    builtAt: doc.builtAt || null,
    total: cards.length,
    byApp,
    missing,
    ...extra,
  };
}

/** 统一入口：把一行命令（`list 20` / `search 插件` / `card <id>` / `status`）变成 payload。 */
export function runQuery(indexDir, line) {
  const [verb = 'list', ...rest] = String(line || '').trim().split(/\s+/);
  const arg = rest.join(' ').trim();
  if (verb === 'status') return indexStatus(indexDir);
  if (verb === 'card') return cardDetail(indexDir, { id: arg });
  if (verb === 'search') return searchCards(indexDir, { query: arg });
  return listCards(indexDir, { limit: Number.parseInt(arg, 10) || 60 });
}
