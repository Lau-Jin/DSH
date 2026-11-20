/**
 * dsh-session-index v2.4.1 — 零依赖 MCP 插件，装上即用、新会话免重启识别
 *
 * 统一索引 DSH + WorkBuddy 全部历史会话，提供：
 *   - 跨会话会话卡与结论速览、关联、血缘
 *   - 可写入的长期记忆（remember / recall / forget）
 *   - 本地语义检索（同义扩展 + BM25 重排）与可选向量增强
 *   - prompts / resources / instructions 自描述与自动上下文注入
 *   - fs.watch 事件驱动：新会话产生后自动纳入索引，无需重启 DSH
 *   - 索引更新后发送 MCP list_changed 通知，客户端自动刷新
 *   - 自动打包插件包 / 技能包（零依赖 ZIP），无需手工压缩
 *
 * 协议：JSON-RPC 2.0 over newline-delimited JSON (MCP stdio)。
 * 铁律：stdout 只允许写 JSON-RPC 响应/通知；所有日志一律走 stderr。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { buildIndex, defaultPaths } from './build-index.mjs';
import { AutoIndex } from './lib/auto.mjs';
import { loadMeta, loadCards, readRecords, indexSizeBytes, signatureOf } from './lib/index-store.mjs';
import { isSystemInjected } from './lib/extract.mjs';
import { relatedTo, matchQuery, threadOf } from './lib/cards.mjs';
import { projectOf, groupByProject, matches as matchesWorkspace } from './lib/workspace.mjs';
import { extractOpenItems } from './lib/todos.mjs';
import { loadNotes, saveNotes, addNote, queryNotes, removeNote, noteChunks, notesStats } from './lib/notes.mjs';
import { expandQuery, matchesQuery, rankCandidates, rrfMerge, makeSnippet } from './lib/semantic.mjs';
import { embeddingConfig, syncVectors, vectorRank, cardChunks, vectorStats } from './lib/embedding.mjs';
import { pack, packAll, listPacks } from './lib/pack.mjs';
import { stageConfig, buildStageDocument, stageToken, bridgeOverview, findDuplicate, postStage, StageError } from './lib/stage.mjs';

const { sessionsRoot, indexDir, workbuddyProjectsDir } = defaultPaths();
const VERSION = '3.1.0';
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const log = (...parts) => process.stderr.write(`[dsh-session-index] ${parts.join(' ')}\n`);

let lastNotifyAt = 0;
/** 索引确有更新时通知 MCP 客户端刷新资源/提示词，节流 30 秒避免打扰。 */
function notifyIndexUpdated(result) {
  const now = Date.now();
  if (now - lastNotifyAt < 30000) return;
  lastNotifyAt = now;
  send({ jsonrpc: '2.0', method: 'notifications/resources/list_changed', params: {} });
  send({ jsonrpc: '2.0', method: 'notifications/prompts/list_changed', params: {} });
  log(`已通知客户端索引更新（+${result.rebuilt} 个会话）`);
}

const auto = new AutoIndex({
  indexDir,
  sessionsRoot,
  watchDirs: [sessionsRoot, workbuddyProjectsDir],
  onIndexUpdated: notifyIndexUpdated,
  log,
});

/** 进程内缓存：同一会话索引只解压一次，signature 变化自动失效。 */
const recordCache = new Map();
const freshMeta = () => loadMeta(indexDir, sessionsRoot);
const freshCards = () => loadCards(indexDir);
const freshNotes = () => loadNotes(indexDir);
const json = (value) => JSON.stringify(value, null, 2);

function getRecords(sessionMeta) {
  const hit = recordCache.get(sessionMeta.id);
  if (hit && hit.sig === sessionMeta.signature) return hit.records;
  const records = readRecords(indexDir, sessionMeta);
  recordCache.set(sessionMeta.id, { sig: sessionMeta.signature, records });
  return records;
}
function clamp(n, min, max, fallback) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : fallback;
}
function fail(message) {
  throw new Error(message);
}
const appOf = (x) => x?.app || 'dsh';
const matchApp = (app, filter) => !filter || filter === 'all' || app === filter;
const filterByApp = (rows, filter) => rows.filter((r) => matchApp(appOf(r), filter));
const filteredCardsDoc = (doc, filter) => {
  if (!filter || filter === 'all') return doc;
  return { cards: Object.fromEntries(Object.entries(doc.cards || {}).filter(([, c]) => matchApp(appOf(c), filter))) };
};

function listSourceFiles(root, maxDepth = 3) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || !fs.existsSync(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl.zstd')) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}
function resolveSession(meta, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) fail('sessionId 不能为空');
  if (meta.sessions[sessionId]) return meta.sessions[sessionId];
  const key = sessionId.toLowerCase();
  const matches = Object.values(meta.sessions).filter((s) => s.id.toLowerCase().startsWith(key));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) fail(`sessionId 前缀匹配到 ${matches.length} 个会话，请给更长的前缀`);
  fail(`未找到会话 ${sessionId}，先用 session_index_list 获取 id`);
}
function resolveCardId(cardsDoc, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) fail('sessionId 不能为空');
  const cards = cardsDoc.cards || {};
  if (cards[sessionId]) return sessionId;
  const key = sessionId.toLowerCase();
  const matches = Object.keys(cards).filter((k) => k.toLowerCase().startsWith(key));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) fail(`sessionId 前缀匹配到 ${matches.length} 个会话卡，请给更长前缀`);
  fail(`未找到会话卡 ${sessionId}，先跑 session_index_refresh`);
}

// ---------------------------------------------------------------- 工具：状态与盘点

function toolStatus() {
  const meta = freshMeta();
  const cardsDoc = freshCards();
  const notesDoc = freshNotes();
  const sessions = Object.values(meta.sessions);
  const bySignature = new Map(sessions.map((s) => [s.sourcePath, s.signature]));
  let pending = 0;
  let sourceBytes = 0;
  for (const file of listSourceFiles(sessionsRoot)) {
    try {
      const st = fs.statSync(file);
      sourceBytes += st.size;
      if (bySignature.get(file) !== signatureOf(st)) pending += 1;
    } catch {
      // ignore
    }
  }
  const byApp = {};
  for (const s of sessions) byApp[appOf(s)] = (byApp[appOf(s)] || 0) + 1;
  const indexBytes = indexSizeBytes(indexDir);
  const cfg = embeddingConfig();
  const notes = notesStats(notesDoc);
  return {
    ready: sessions.length > 0,
    indexedSessions: sessions.length,
    byApp,
    indexedRecords: sessions.reduce((n, s) => n + (s.records || 0), 0),
    crossSessionCards: Object.keys(cardsDoc.cards || {}).length,
    activeMemories: notes.active,
    sourceBytes,
    indexBytes,
    compressionRatio: sourceBytes ? +(indexBytes / sourceBytes).toFixed(3) : null,
    builtAt: meta.builtAt,
    cardsBuiltAt: cardsDoc.builtAt,
    notesUpdatedAt: notes.updatedAt,
    pendingChanges: pending,
    searchMode: 'semantic (本地同义扩展 + BM25，零 token)',
    vectorEnabled: cfg.enabled,
    vectorModel: cfg.enabled ? cfg.model : null,
    autoIndex: auto.snapshot(),
    packs: listPacks().packs.map((p) => ({ name: p.name, bytes: p.bytes, valid: p.valid })),
    sessionsRoot,
    indexDir,
    hint: '新会话由文件事件自动纳入，无需重启 DSH；会话开始先调 session_index_brief',
  };
}

function toolList(args = {}) {
  const meta = freshMeta();
  const workspace = typeof args.workspace === 'string' ? args.workspace.toLowerCase() : '';
  const since = Number(args.since) || 0;
  const until = Number(args.until) || Number.MAX_SAFE_INTEGER;
  const limit = clamp(args.limit, 1, 50, 20);
  const offset = clamp(args.offset, 0, 100000, 0);
  const inRange = (s) => {
    if (workspace && !String(s.workspace || '').toLowerCase().includes(workspace)) return false;
    const t = s.updatedAt || 0;
    return t >= since && t <= until;
  };
  let rows = filterByApp(Object.values(meta.sessions), args.app).filter(inRange);

  // 补上「只有会话卡、本机没有对应会话文件」的 —— 那是**从别的机器同步过来**的，
  // 只落在 cards.json 里，meta 里没有，不补的话 list 看不见它们。
  const cards = freshCards().cards || {};
  const localIds = new Set(Object.keys(meta.sessions));
  for (const card of Object.values(cards)) {
    if (!card || localIds.has(card.id)) continue;
    if (args.app && args.app !== 'all' && appOf(card) !== args.app) continue;
    if (!inRange(card)) continue;
    rows.push({
      id: card.id,
      app: appOf(card),
      title: card.title || '',
      workspace: card.workspace || '',
      createdAt: card.createdAt || 0,
      updatedAt: card.updatedAt || 0,
      records: card.recordCount || 0,
      sourceBytes: 0,
      imported: true,
    });
  }

  rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const total = rows.length;
  rows = rows.slice(offset, offset + limit);
  return {
    total,
    returned: rows.length,
    offset,
    sessions: rows.map((s) => ({
      id: s.id, app: appOf(s), title: s.title, workspace: s.workspace,
      createdAt: s.createdAt, updatedAt: s.updatedAt, records: s.records,
      sourceBytes: s.sourceBytes, parentSession: s.parentSession || undefined,
      // imported=true = 这条是同步来的，本机没有原文（get 只能看会话卡）
      imported: s.imported ? true : undefined,
    })),
    hint: '用 session_index_get 看骨架、session_index_related 找关联；app 可填 dsh / workbuddy / all。'
      + '标了 imported 的是从别的机器同步来的会话卡，本机没有原文。',
  };
}

// ---------------------------------------------------------------- 工具：跨会话层

function toolBrief(args = {}) {
  const cardsDoc = freshCards();
  const cards = cardsDoc.cards || {};
  const limit = clamp(args.limit, 1, 20, 8);
  const maxChars = clamp(args.maxChars, 500, 20000, 4000);
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const workspace = typeof args.workspace === 'string' ? args.workspace.toLowerCase() : '';
  const app = args.app || 'all';
  const scoped = filteredCardsDoc(cardsDoc, app);
  let rows;
  if (query) {
    rows = matchQuery(scoped, query, { limit, workspace }).map((r) => ({
      card: r.card,
      match: { score: r.score, hitKeywords: r.hitKeywords, hitPaths: r.hitPaths },
    }));
  } else {
    rows = Object.values(scoped.cards)
      .filter((c) => !workspace || String(c.workspace || '').toLowerCase().includes(workspace))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, limit)
      .map((card) => ({ card, match: null }));
  }
  const includeMemory = args.includeMemory !== false;
  let memories = [];
  if (includeMemory) {
    const rec = queryNotes(freshNotes(), { query, limit: clamp(args.memoryLimit, 1, 20, 5) });
    memories = rec.map((r) => ({
      id: r.note.id, type: r.note.type, text: String(r.note.text).slice(0, 200),
      tags: r.note.tags, importance: r.note.importance, score: +r.score.toFixed(2),
    }));
  }
  if (rows.length === 0 && memories.length === 0) {
    return {
      mode: query ? 'topic' : 'recent', totalCards: Object.keys(cards).length,
      returned: 0, memories: [], sessions: [],
      hint: query ? `没有与「${query}」相关的历史，换更短的词或改用 session_index_search` : '索引正在后台自动构建，请稍候',
    };
  }
  let used = 0;
  const items = [];
  for (const { card, match } of rows) {
    const remain = maxChars - used;
    if (remain < 120) break;
    const item = {
      id: card.id, app: appOf(card), title: String(card.title || '').slice(0, 100),
      updatedAt: card.updatedAt, digest: String(card.digest || '').slice(0, 140),
      decisions: (card.decisions || []).slice(0, 2).map((d) => String(d).slice(0, 140)),
      questions: (card.questions || []).slice(0, 1).map((q) => String(q).slice(0, 120)),
      sharedPaths: (card.paths || []).slice(0, 3), keywords: (card.keywords || []).slice(0, 6),
    };
    if (match) item.match = match;
    if (JSON.stringify(item).length > remain && item.decisions.length > 1) item.decisions = item.decisions.slice(0, 1);
    items.push(item);
    used += Math.min(JSON.stringify(item).length, remain);
  }
  return {
    mode: query ? 'topic' : 'recent', query: query || undefined, app,
    totalCards: Object.keys(cards).length, returned: items.length, truncated: used >= maxChars,
    memories, memoryCount: memories.length, sessions: items,
    hint: '只读会话卡与记忆。细节用 search/get，关联用 related/thread，记新结论用 remember',
  };
}

function toolRelated(args = {}) {
  const scoped = filteredCardsDoc(freshCards(), args.app || 'all');
  const seedId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const limit = clamp(args.limit, 1, 20, 6);
  const workspace = typeof args.workspace === 'string' ? args.workspace : '';
  if (!seedId && !query) fail('需要 sessionId 或 query 之一');
  if (seedId) {
    const res = relatedTo(scoped, resolveCardId(scoped, seedId), { limit, workspace });
    if (res.error) fail(res.error);
    res.hint = '依据共享路径/关键词/工具/父子关系；跨应用会话也会被关联';
    return res;
  }
  const seeds = matchQuery(scoped, query, { limit: 3, workspace });
  if (seeds.length === 0) return { query, returned: 0, related: [], hint: '换更短的词或改用 search' };
  const merged = new Map();
  for (const s of seeds) {
    const res = relatedTo(scoped, s.card.id, { limit, workspace });
    for (const r of res.related || []) {
      const prev = merged.get(r.id);
      if (!prev || r.score > prev.score) merged.set(r.id, { ...r, via: s.card.id });
    }
  }
  return {
    query, seeds: seeds.map((s) => s.card.id), returned: Math.min(limit, merged.size),
    related: [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit),
    hint: '由主题种子会话扩展出的关联会话',
  };
}

function toolThread(args = {}) {
  const cardsDoc = freshCards();
  const id = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  if (!id) fail('sessionId 不能为空');
  const res = threadOf(cardsDoc, resolveCardId(cardsDoc, id), { maxDepth: clamp(args.maxDepth, 1, 10, 6) });
  if (res.error) fail(res.error);
  res.hint = 'ancestors 上游 / descendants 派生子会话 / siblings 同源兄弟';
  return res;
}

// ---------------------------------------------------------------- 工具：语义检索

function noteDocs() {
  return freshNotes().notes.filter((n) => !n.archived).map((n) => ({
    kind: 'memory', noteId: n.id, sessionId: n.sessionId || null, app: n.app || 'manual',
    title: `[${n.type}] ${(n.tags || []).join('/')}`, role: 'memory', t: 'memory',
    ts: n.updatedAt, i: -1, text: `${n.text} ${(n.tags || []).join(' ')}`,
  }));
}
function cardDocs(doc, app, filter) {
  return Object.values(doc.cards || {})
    .filter((c) => matchApp(appOf(c), app))
    .filter((c) => (typeof filter === 'function' ? filter(c) : true))
    .map((c) => ({
      kind: 'card', sessionId: c.id, app: appOf(c), title: c.title, role: 'card', t: 'card',
      ts: c.updatedAt, i: -1,
      // 关键词也进正文：会话卡是**同步来的会话**在本机唯一可搜的文本，
      // 只放标题+提问+结论会漏掉「按关键词找那次会话」这种用法。
      text: [c.title, ...(c.questions || []), ...(c.decisions || []), ...(c.keywords || [])].join('\n'),
    }));
}
function toSearchResult(row, eq, contextChars) {
  const it = row.item;
  const base = {
    title: it.title, app: it.app, kind: it.kind || 'record', score: row.score,
    matched: row.matched,
    matchType: row.matched?.some((t) => eq.terms.includes(t)) ? 'exact' : 'expanded',
    snippet: makeSnippet(it.text, eq, contextChars),
  };
  if (it.kind === 'record') {
    Object.assign(base, { sessionId: it.sessionId, seq: it.i, role: it.role, type: it.t, time: it.ts, tool: it.tool });
  } else {
    Object.assign(base, { sessionId: it.sessionId || null, noteId: it.noteId, time: it.ts });
  }
  return base;
}
async function toolSearch(args = {}) {
  if (typeof args.query !== 'string' || !args.query.trim()) fail('query 不能为空');
  const mode = ['keyword', 'semantic', 'hybrid', 'vector'].includes(args.mode) ? args.mode : 'semantic';
  const eq = expandQuery(args.query);
  if (mode === 'keyword' && eq.terms.length === 0) fail('query 需要至少一个有效关键词');
  const meta = freshMeta();
  const cardsDoc = freshCards();
  const app = args.app || 'all';
  const workspace = typeof args.workspace === 'string' ? args.workspace.toLowerCase() : '';
  const sessionFilter = typeof args.sessionId === 'string' ? args.sessionId.toLowerCase() : '';
  const role = typeof args.role === 'string' ? args.role.toLowerCase() : '';
  const type = typeof args.type === 'string' ? args.type.toLowerCase() : '';
  const since = Number(args.since) || 0;
  const until = Number(args.until) || Number.MAX_SAFE_INTEGER;
  const limit = clamp(args.limit, 1, 30, 8);
  const offset = clamp(args.offset, 0, 100000, 0);
  const contextChars = clamp(args.contextChars, 40, 800, 180);
  const includeSystem = Boolean(args.includeSystem);
  const candidates = filterByApp(Object.values(meta.sessions), app).filter((s) => {
    if (workspace && !String(s.workspace || '').toLowerCase().includes(workspace)) return false;
    if (sessionFilter && !s.id.toLowerCase().includes(sessionFilter)) return false;
    return (s.updatedAt || 0) >= since && (s.updatedAt || 0) <= until;
  });
  // 会话卡也要过同样的过滤：从别的机器同步来的会话**本机没有记录文件**，
  // 只在 cards.json 里；不把它们算进候选，那台机器上就搜不到任何东西。
  const cardFilter = (c) => {
    if (workspace && !String(c.workspace || '').toLowerCase().includes(workspace)) return false;
    if (sessionFilter && !String(c.id || '').toLowerCase().includes(sessionFilter)) return false;
    return (c.updatedAt || 0) >= since && (c.updatedAt || 0) <= until;
  };
  const cardCandidates = cardDocs(cardsDoc, app, cardFilter);
  if (candidates.length === 0 && cardCandidates.length === 0) {
    fail('没有符合过滤条件的会话，先用 session_index_list 看看');
  }
  const docs = [];
  for (const s of candidates) {
    for (const r of getRecords(s)) {
      if (!includeSystem && isSystemInjected(r)) continue;
      if (role && String(r.role).toLowerCase() !== role) continue;
      if (type && !String(r.t).toLowerCase().includes(type)) continue;
      const text = String(r.text || '');
      if (mode === 'keyword') {
        const lower = text.toLowerCase();
        if (!eq.terms.every((t) => lower.includes(t))) continue;
      } else if (matchesQuery(text, eq) === 0) continue;
      docs.push({ ...r, sessionId: s.id, title: s.title, app: appOf(s), kind: 'record' });
    }
  }
  let ranked;
  if (mode === 'keyword') {
    // 精确匹配也要算上会话卡：同步来的会话只有卡，没有本机记录
    const keywordDocs = [...docs, ...cardCandidates];
    ranked = keywordDocs.map((it) => ({
      item: it,
      score: eq.terms.reduce((n, t) => n + (String(it.text || '').toLowerCase().split(t).length - 1), 0),
      matched: eq.terms,
    })).sort((a, b) => b.score - a.score || b.item.ts - a.item.ts);
  } else {
    ranked = rankCandidates([...docs, ...noteDocs(), ...cardCandidates], eq);
  }
  const cfg = embeddingConfig();
  let vectorInfo = null;
  let degraded = false;
  if (mode === 'hybrid' || mode === 'vector') {
    if (cfg.enabled) {
      try {
        const vr = await vectorRank(indexDir, args.query, cfg, 20);
        if (vr.ok) {
          const vIds = vr.results.map((r) => r.sessionId).filter(Boolean);
          const rankedIds = ranked.map((r) => r.item.sessionId || r.item.noteId || '');
          const order = new Map(rrfMerge([rankedIds, vIds]).map((m, i) => [m.id, i]));
          ranked.sort((a, b) =>
            (order.get(a.item.sessionId || a.item.noteId || '') ?? 9999) -
              (order.get(b.item.sessionId || b.item.noteId || '') ?? 9999) || b.score - a.score);
          vectorInfo = { model: vr.model, candidates: vr.returned };
        }
      } catch (err) {
        log('向量检索降级: ' + err.message);
        vectorInfo = { error: err.message };
      }
    } else degraded = true;
  }
  const page = ranked.slice(offset, offset + limit).map((row) => toSearchResult(row, eq, contextChars));

  // 按会话聚合（默认开）：同一会话命中 5 段时，返回 5 条几乎相同的上下文纯属浪费 token。
  // 每个会话只留**得分最高的那条**当代表，其余 seq 收进 moreSeqs，并给 hitCount。
  // 想看全部原始命中就传 group:false。
  const group = args.group !== false;
  let grouped = null;
  if (group) {
    const bySession = new Map();
    for (const row of ranked) {
      const key = row.item.sessionId || row.item.noteId || '(unknown)';
      const slot = bySession.get(key);
      if (!slot) {
        bySession.set(key, { best: row, seqs: row.item.i >= 0 ? [row.item.i] : [], count: 1 });
        continue;
      }
      slot.count += 1;
      if (row.item.i >= 0) slot.seqs.push(row.item.i);
      if (row.score > slot.best.score) slot.best = row;
    }
    const groups = [...bySession.values()]
      .sort((a, b) => b.best.score - a.best.score)
      .slice(offset, offset + limit)
      .map((slot) => {
        const base = toSearchResult(slot.best, eq, contextChars);
        return {
          ...base,
          hitCount: slot.count,
          moreSeqs: slot.seqs.filter((s) => s !== slot.best.item.i).slice(0, 12),
        };
      });
    grouped = {
      sessions: groups.length,
      hits: ranked.length,
      results: groups,
      hint: groups.length < ranked.length
        ? '已按会话聚合：每个会话只给最相关的片段，其余命中收在 moreSeqs 里（要逐条看传 group:false）'
        : undefined,
    };
  }

  return {
    query: args.query, mode: degraded ? 'semantic' : mode, degraded,
    degradeReason: degraded ? '未配置 embedding，已降级为本地语义检索（零 token）' : undefined,
    expandedTerms: mode === 'keyword' ? undefined : eq.expanded,
    total: ranked.length, returned: page.length, offset,
    sessionsScanned: candidates.length, app, systemIncluded: includeSystem, vectorInfo,
    // grouped=true 时 results 是「每个会话一条代表」；grouped=false 时是原始逐条命中
    results: grouped ? grouped.results : page,
    grouped: Boolean(grouped),
    hitSessions: grouped ? grouped.sessions : undefined,
    hint: grouped && grouped.hint
      ? grouped.hint
      : '默认语义模式：同义扩展召回 + BM25 重排，只返回片段。完整原文用 session_index_get',
  };
}

// ---------------------------------------------------------------- 工具：原文与记忆

function toolGet(args = {}) {
  const meta = freshMeta();
  let s = null;
  try {
    s = resolveSession(meta, args.sessionId);
  } catch (err) {
    // 本机没有这个会话的记录 —— 多半是**从别的机器同步来的会话卡**。
    // 那就用会话卡作答（结论 / 提问 / 涉及路径 / 关键词），而不是一句「会话不存在」。
    const cardsDoc = freshCards();
    let cardId = null;
    try {
      cardId = resolveCardId(cardsDoc, String(args.sessionId || ''));
    } catch {
      cardId = null;
    }
    const card = cardId ? cardsDoc.cards[cardId] : null;
    if (!card) throw err;
    return {
      mode: 'card', sessionId: card.id, app: appOf(card), title: card.title || '',
      imported: true,
      totalRecords: card.recordCount || 0,
      decisions: card.decisions || [],
      questions: card.questions || [],
      paths: card.paths || [],
      files: card.files || [],
      tools: card.tools || [],
      keywords: card.keywords || [],
      digest: card.digest || '',
      hint: '这台机器上没有该会话的原文（数据来自其它机器同步的会话卡），'
        + '所以只能给出会话卡里的结论 / 提问 / 涉及路径；要看原文请到产生它的那台机器上查。',
    };
  }
  const records = getRecords(s);
  const maxChars = clamp(args.maxChars, 200, 30000, 6000);
  const seqs = Array.isArray(args.seqs) ? args.seqs.map(Number).filter(Number.isFinite) : [];
  const hasFrom = Number.isFinite(Number(args.seqFrom)) && args.seqFrom !== undefined;
  const hasTo = Number.isFinite(Number(args.seqTo)) && args.seqTo !== undefined;
  if (seqs.length === 0 && !hasFrom && !hasTo) {
    const users = records.filter((r) => r.role === 'user' && !isSystemInjected(r)).slice(0, 25);
    const others = records.filter((r) => r.role !== 'user').slice(0, 10);
    return {
      mode: 'outline', sessionId: s.id, app: appOf(s), title: s.title,
      totalRecords: records.length, outlineCount: users.length + others.length,
      outline: [...users, ...others].sort((a, b) => a.i - b.i)
        .map((r) => ({ seq: r.i, role: r.role, type: r.t, preview: r.text.slice(0, 80).replace(/\s+/g, ' ') })),
      hint: '骨架只给预览。用 seqs 或 seqFrom/seqTo 取完整原文',
    };
  }
  const wanted = new Set(seqs);
  let picked = records.filter((r) => {
    if (wanted.has(r.i)) return true;
    if (hasFrom && r.i < Number(args.seqFrom)) return false;
    if (hasTo && r.i > Number(args.seqTo)) return false;
    return hasFrom || hasTo;
  }).sort((a, b) => a.i - b.i).slice(0, 50);
  let used = 0;
  const items = [];
  for (const r of picked) {
    const remain = maxChars - used;
    if (remain <= 0) break;
    const cut = r.text.length > remain;
    items.push({
      seq: r.i, role: r.role, type: r.t, time: r.ts, tool: r.tool,
      cut: cut || Boolean(r.cut), text: cut ? r.text.slice(0, remain) : r.text,
    });
    used += cut ? remain : r.text.length;
  }
  return {
    mode: 'records', sessionId: s.id, app: appOf(s), title: s.title,
    matched: picked.length, returned: items.length, truncated: used >= maxChars, items,
  };
}
const publicNote = (n) => ({
  id: n.id, text: n.text, type: n.type, tags: n.tags, importance: n.importance,
  app: n.app, sessionId: n.sessionId, createdAt: n.createdAt, updatedAt: n.updatedAt,
  archived: Boolean(n.archived),
});
function toolRemember(args = {}) {
  const doc = freshNotes();
  const result = addNote(doc, args);
  saveNotes(indexDir, doc);
  return {
    ok: true, created: result.created, merged: result.merged,
    total: notesStats(doc).active, note: publicNote(result.note),
    hint: result.created ? '已写入。之后 brief / semantic search 会自动召回' : '已有相同记忆，已合并重要度与标签',
  };
}
function toolRecall(args = {}) {
  const doc = freshNotes();
  const rows = queryNotes(doc, args);
  return {
    returned: rows.length, total: notesStats(doc).active,
    notes: rows.map((r) => ({ ...publicNote(r.note), score: +r.score.toFixed(2), matched: r.matched })),
    hint: '召回结果已按相关度+重要度+新鲜度排序；forget 传 id 可归档',
  };
}
function toolForget(args = {}) {
  if (!args.id) fail('需要记忆 id');
  const doc = freshNotes();
  const res = removeNote(doc, String(args.id), Boolean(args.purge));
  saveNotes(indexDir, doc);
  return { ok: true, ...res, remaining: notesStats(doc).active, hint: res.purged ? '已物理删除' : '已归档（默认，可恢复）' };
}

// ---------------------------------------------------------------- 工具：打包 / 向量 / 刷新

function toolPackage(args = {}) {
  const mode = ['plugin', 'skill', 'all', 'status'].includes(args.mode) ? args.mode : 'all';
  if (mode === 'status') {
    return { ok: true, mode, ...listPacks() };
  }
  try {
    const packages = mode === 'all' ? packAll() : [pack({ mode })];
    return {
      ok: true,
      mode,
      packages,
      hint: '包内含 MANIFEST.json 与 INSTALL.md，不含任何会话数据/索引/密钥，可直接分发；接收方解压后运行 node install.mjs',
    };
  } catch (err) {
    return { ok: false, mode, error: err.message };
  }
}

async function toolVectors(args = {}) {
  const action = ['status', 'sync', 'search'].includes(args.action) ? args.action : 'status';
  const cfg = embeddingConfig();
  const stats = { ...vectorStats(indexDir), enabled: cfg.enabled, model: cfg.enabled ? cfg.model : vectorStats(indexDir).model };
  if (action === 'status') {
    return { ...stats, hint: cfg.enabled ? '可用 sync 更新向量缓存' : '未配置 SESSION_INDEX_EMBED_* 环境变量；本地语义检索无需向量，零成本' };
  }
  if (!cfg.enabled) fail('未配置 embedding（SESSION_INDEX_EMBED_URL / KEY / MODEL），无法执行 ' + action);
  if (action === 'search') {
    if (!args.query) fail('search 需要 query');
    const res = await vectorRank(indexDir, args.query, cfg, clamp(args.limit, 1, 30, 10));
    return { ...res, hint: '纯向量余弦相似度；通常直接用 session_index_search 的 hybrid 模式' };
  }
  const chunks = [...cardChunks(freshCards()), ...noteChunks(freshNotes())];
  try {
    const res = await syncVectors(indexDir, chunks, cfg);
    return { ...res, chunks: chunks.length, hint: '向量按文本 hash 增量缓存，重复同步不会重复调用接口' };
  } catch (err) {
    return { ok: false, error: err.message, hint: '检查 /embeddings 端点、模型名与密钥；不影响本地语义检索' };
  }
}
async function toolRefresh(args = {}) {
  const force = Boolean(args.force);
  try {
    const stats = buildIndex({ sessionsRoot, indexDir, force });
    recordCache.clear();
    let vector = null;
    const cfg = embeddingConfig();
    if (cfg.enabled) {
      try {
        vector = await syncVectors(indexDir, [...cardChunks(freshCards()), ...noteChunks(freshNotes())], cfg);
      } catch (err) {
        vector = { ok: false, error: err.message };
      }
    }
    return {
      ok: true, rebuilt: stats.rebuilt, skipped: stats.skipped, byApp: stats.byApp,
      sessionsIndexed: stats.sessionsIndexed, cardsIndexed: stats.cardsIndexed,
      cardsBuilt: stats.cardsBuilt, records: stats.records, indexBytes: stats.indexBytes,
      elapsedMs: stats.elapsedMs, vector, warnings: stats.warnings.slice(0, 5),
      autoIndex: auto.snapshot(),
      hint: '索引默认由文件事件 + 后台轮询自动维护，此工具仅用于立即手动刷新',
    };
  } catch (err) {
    return { ok: false, error: err.message, hint: '需要 Node >= 22.15 且会话目录可读' };
  }
}

/**
 * 控制器：会话整理文档 → 思源桥待入库队列。
 * 只负责解析参数、组装源数据、格式化响应；渲染与 HTTP 都在 lib/stage.mjs。
 * 两步确认：不带 confirmToken 一律只预览，带对 token 才投递；永不写库。
 */
// ---------------------------------------------------------------- 工具：未完成事项 / 接续包 / 体检


/**
 * 跨会话「未完成事项」聚合。
 *
 * 数据来源两档（v3.1 起卡片自带 `openItems`）：
 *   - 默认**读卡片**：建卡时就抽好了，0 解压成本，面板与工具共用同一份；
 *   - `refresh: true` 或卡片还没有该字段（老索引）→ 现读会话分片重算。
 */
function toolTodos(args = {}) {
  const limit = clamp(args.limit, 1, 80, 20);
  const perSession = clamp(args.perSession, 1, 20, 4);
  const since = Number(args.since) || 0;
  const maxItems = clamp(args.maxItems, 1, 200, 40);
  const forceRecords = Boolean(args.refresh);
  const cardsDoc = freshCards();
  const cards = Object.values(cardsDoc.cards || {})
    .filter((c) => matchApp(appOf(c), args.app || 'all'))
    .filter((c) => (args.workspace ? matchesWorkspace(c.workspace, args.workspace) : true))
    .filter((c) => (c.updatedAt || 0) >= since)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, limit);

  if (cards.length === 0) fail('没有符合条件的会话，先用 session_index_list 看看');

  let fromCards = 0;
  let fromRecords = 0;
  const sessions = [];
  for (const card of cards) {
    const persisted = !forceRecords && Array.isArray(card.openItems);
    if (persisted) {
      fromCards += 1;
      // 复用聚合器要的 {card, records} 形状：把卡片里的 openItems 包成「记录」喂进去
      sessions.push({
        card,
        records: card.openItems.length
          ? card.openItems.map((item) => ({
            i: item.seq, role: 'assistant', t: 'card-open-item', ts: item.time, text: item.text,
            // 已在建卡时抽过，标记特征让 classify 不再过滤
            __preclassified: item.kind,
          }))
          : [],
        preclassified: card.openItems,
      });
      continue;
    }
    const meta = freshMeta();
    const s = meta.sessions[card.id];
    if (!s) { sessions.push({ card, records: null }); continue; }
    fromRecords += 1;
    sessions.push({ card, records: getRecords(s) });
  }

  // 卡片来源的直接展开（不走 extractOpenItems，避免二次过滤把已抽好的丢掉）
  const items = [];
  for (const entry of sessions) {
    const card = entry.card;
    const project = projectOf(card.workspace) || '(未记录)';
    if (entry.preclassified) {
      for (const item of entry.preclassified.slice(0, perSession)) {
        items.push({
          text: item.text, seq: item.seq, kind: item.kind, time: item.time, role: 'assistant',
          sessionId: card.id, title: String(card.title || ''), app: appOf(card),
          workspace: card.workspace || '', project, sessionUpdatedAt: card.updatedAt || 0,
          source: 'card',
        });
      }
      continue;
    }
    const open = Array.isArray(entry.records) ? extractOpenItems(entry.records).slice(0, perSession) : [];
    for (const item of open) {
      items.push({
        ...item,
        sessionId: card.id, title: String(card.title || ''), app: appOf(card),
        workspace: card.workspace || '', project, sessionUpdatedAt: card.updatedAt || 0,
        source: 'records',
      });
    }
  }

  items.sort((a, b) => (b.time || 0) - (a.time || 0) || (b.sessionUpdatedAt || 0) - (a.sessionUpdatedAt || 0));

  // 跨会话去重（同一件事常被多个会话复述）
  const byKey = new Map();
  let deduped = 0;
  for (const item of items) {
    const key = String(item.text).toLowerCase().replace(/[\s`'"“”‘’（）()【】\[\]<>《》:：,，.。!！?？;；、/\\|-]+/g, '').slice(0, 120);
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, item); continue; }
    deduped += 1;
    const keepNew = (item.time || 0) > (prev.time || 0)
      || ((item.time || 0) === (prev.time || 0) && (item.sessionUpdatedAt || 0) > (prev.sessionUpdatedAt || 0));
    const keep = keepNew ? item : prev;
    const other = keepNew ? prev : item;
    byKey.set(key, {
      ...keep,
      alsoInSessions: [...(prev.alsoInSessions || []), ...(item.alsoInSessions || []), other.sessionId]
        .filter((id, i, arr) => id && id !== keep.sessionId && arr.indexOf(id) === i).slice(0, 4),
    });
  }
  const uniq = [...byKey.values()];
  const kept = uniq.slice(0, maxItems);

  const groups = new Map();
  for (const item of kept) {
    const key = `${item.app}|${item.project.toLowerCase()}`;
    let slot = groups.get(key);
    if (!slot) { slot = { app: item.app, project: item.project, count: 0, items: [] }; groups.set(key, slot); }
    slot.count += 1;
    slot.items.push(item);
  }

  const missingPersisted = cards.filter((c) => !Array.isArray(c.openItems)).length;
  return {
    scanned: cards.length,
    fromCards,
    fromRecords,
    skipped: cards.length - fromCards - fromRecords,
    total: uniq.length,
    rawTotal: items.length,
    crossSessionDeduped: deduped,
    returned: kept.length,
    truncated: uniq.length > kept.length,
    items: kept,
    byProject: [...groups.values()].sort((a, b) => b.count - a.count),
    scope: { app: args.app || 'all', workspace: args.workspace || '', since: since || undefined, limit },
    hint: missingPersisted
      ? `${missingPersisted} 张卡还没有预抽的未完成事项（老索引）；跑一次 session_index_refresh {force:true} 或传 refresh:true 现读`
      : (uniq.length ? '纯规则抽取，可能含「方案里提到的步骤」。要看上下文用 session_index_get 按 sessionId+seq 取原文'
        : '这些会话里没抽到未完成事项（也可能已经做完了）。放大 limit 或指定 workspace 再试'),
  };
}

/**
 * 「未完成事项」→ 思源桥待入库（面板「待办」页签用，也供 resume 复用）。
 * 只入队，**绝不 commit**（写入笔记库永远由人在思源桥界面点）。
 */
async function stageTodos(items, opts = {}) {
  const cfg = stageConfig();
  const title = String(opts.title || `未完成事项汇总（${items.length} 条）`).slice(0, 120);
  const lines = [
    `# ${title}`,
    '',
    `> 由 dsh-session-index 的 \`session_index_todos\` 生成；**本稿只进了「待入库」队列，未写入笔记库**。`,
    `> 生成时间：${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    '',
  ];
  const groups = new Map();
  for (const item of items) {
    const key = `${item.app}|${item.project || '(未记录)'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const [key, rows] of groups) {
    lines.push(`## ${rows[0].project || '(未记录)'}（${rows[0].app} · ${rows.length} 条）`, '');
    for (const item of rows) {
      const when = item.time ? new Date(item.time).toISOString().slice(0, 10) : '';
      lines.push(`- **${item.kind === 'todo' ? '待办' : '跟进'}** ${item.text}`);
      lines.push(`  - 来源：${item.title || item.sessionId}（\`${item.sessionId}\` seq ${item.seq}${when ? ` · ${when}` : ''}）`);
    }
    lines.push('');
  }
  const markdown = lines.join('\n');
  const doc = { title, markdown, chars: markdown.length };
  const payloadOpts = {
    notebook: opts.notebook || cfg.defaultNotebook,
    hpath: opts.hpath || cfg.defaultHpath,
    note: opts.note || '会话索引 · 未完成事项',
    template: 'todos',
  };
  const dup = await findDuplicate(cfg, doc);
  if (dup) return { ok: true, staged: false, alreadyQueued: true, id: dup.id, title, chars: doc.chars };
  const result = await postStage(cfg, doc, payloadOpts);
  return { ...result, ok: true, staged: true, title, chars: doc.chars };
}

/**
 * 「接续包」：给一个会话或主题，产出一段可直接粘进新会话的上下文。
 * 面向「接着上次继续干」，所以顺序是：目标 → 结论 → 未完成 → 涉及文件 → 关键词。
 */
async function toolResume(args = {}) {
  const cardsDoc = freshCards();
  const maxChars = clamp(args.maxChars, 800, 20000, 4000);
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  const workspace = typeof args.workspace === 'string' ? args.workspace : '';

  let picked = [];
  if (sessionId) {
    const id = resolveCardId(cardsDoc, sessionId);
    const card = cardsDoc.cards[id];
    if (!card) fail(`没有这张卡：${sessionId}`);
    picked = [card];
  } else if (query) {
    const scoped = filteredCardsDoc(cardsDoc, args.app || 'all');
    picked = matchQuery(scoped, query, { limit: clamp(args.limit, 1, 10, 3), workspace })
      .map((r) => r.card);
    if (picked.length === 0) fail(`没有与「${query}」相关的会话`);
  } else {
    const scoped = filteredCardsDoc(cardsDoc, args.app || 'all');
    picked = Object.values(scoped.cards)
      .filter((c) => (workspace ? matchesWorkspace(c.workspace, workspace) : true))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 1);
    if (picked.length === 0) fail('索引里还没有会话卡');
  }

  const block = [];
  const sections = [];
  let used = 0;
  const push = (line) => {
    if (used + line.length > maxChars) return false;
    block.push(line);
    used += line.length + 1;
    return true;
  };

  push(`# 接续上下文（${new Date().toISOString().slice(0, 16).replace('T', ' ')}）`);
  push('');
  for (const card of picked) {
    const project = projectOf(card.workspace) || '(未记录)';
    push(`## ${card.title || card.id}`);
    push(`- 会话：\`${card.id}\` · ${appOf(card)} · 项目 ${project} · 更新于 ${new Date(card.updatedAt || 0).toISOString().slice(0, 16).replace('T', ' ')}`);
    const lines = [];
    const questions = (card.questions || []).slice(0, 3);
    if (questions.length) {
      push('- 目标：');
      for (const q of questions) { if (push(`  - ${String(q).slice(0, 200)}`)) lines.push('goal'); }
    }
    const decisions = (card.decisions || []).slice(0, 6);
    if (decisions.length) {
      push('- 已有结论：');
      for (const d of decisions) { if (push(`  - ${String(d).slice(0, 220)}`)) lines.push('decision'); }
    }
    // 未完成事项：卡片里已预抽好（v3.1）；老卡片还没有该字段时回落到现读记录，
    // 免得升级后的第一次 resume 缺这一段。
    let open = (card.openItems || []).slice(0, 5);
    if (!Array.isArray(card.openItems)) {
      try {
        const s = freshMeta().sessions[card.id];
        if (s) open = extractOpenItems(getRecords(s)).slice(0, 5);
      } catch { /* 同步来的卡片没有分片，跳过 */ }
    }
    if (open.length) {
      push('- 未完成 / 待跟进：');
      for (const item of open) { if (push(`  - [${item.kind}] ${item.text}（seq ${item.seq}）`)) lines.push('open'); }
    }
    const paths = (card.paths || []).slice(0, 8);
    if (paths.length) {
      push('- 涉及路径：');
      for (const p of paths) { if (push(`  - \`${p}\``)) lines.push('path'); }
    }
    const keywords = (card.keywords || []).slice(0, 8);
    if (keywords.length) { if (push(`- 关键词：${keywords.join('、')}`)) lines.push('keywords'); }
    push('');
    sections.push({
      sessionId: card.id,
      title: card.title || '',
      project,
      hasOpenItems: open.length > 0,
      openItems: open.map((o) => ({ text: o.text, seq: o.seq, kind: o.kind })),
      included: [...new Set(lines)],
    });
  }

  // 相关记忆也带上：这些是跨会话层面已经确认过的事实
  const memories = query || sessionId
    ? queryNotes(freshNotes(), { query: query || picked.map((c) => c.title).join(' '), limit: 5 })
    : [];
  if (memories.length) {
    push('## 已记下的相关事实');
    for (const m of memories) push(`- [${m.note.type}] ${String(m.note.text).slice(0, 200)}`);
  }

  const payload = {
    ok: true,
    sessions: sections,
    memories: memories.map((m) => ({ id: m.note.id, type: m.note.type, text: m.note.text })),
    chars: block.join('\n').length,
    truncated: used >= maxChars,
    context: block.join('\n'),
    hint: '把 context 原样贴进新会话即可接着干。要更细的原文用 session_index_get（sessionId + seqs）'
      + (args.stage ? '；已按 stage:true 投递到思源桥「待入库」（staged 字段）' : '；要直接进思源桥待入库传 stage:true'),
  };

  // ② 一键投递到思源桥「待入库」（只入队，不写库；写入仍由人在思源桥界面确认）
  if (args.stage) {
    try {
      const staged = await stageTodos(
        picked.flatMap((card) => (card.openItems || []).map((item) => ({
          ...item,
          sessionId: card.id,
          title: card.title || '',
          app: appOf(card),
          project: projectOf(card.workspace) || '(未记录)',
        }))),
        {
          title: args.title || `接续上下文 · ${picked.map((c) => c.title || c.id).join(' / ')}`.slice(0, 120),
          notebook: args.notebook,
          hpath: args.hpath,
          note: args.note || '会话索引 · 接续包',
        },
      );
      payload.staged = staged;
    } catch (err) {
      payload.staged = {
        ok: false,
        error: (err && err.message) || String(err),
        hint: (err && err.hint) || '思源桥没起就先用 context 手动粘；启动服务后重试',
      };
    }
  }
  return payload;
}

/**
 * 索引体检：meta / 分片 / 卡片三者一致性 + 体积 + 自动维护状态。
 * fix=true 时只清**确定安全**的东西：过期临时文件、孤儿分片、堆积的 notes 备份。
 */
function toolDoctor(args = {}) {
  const fix = Boolean(args.fix);
  const meta = freshMeta();
  const cardsDoc = freshCards();
  const problems = [];
  const fixes = [];
  const sessions = meta.sessions || {};
  const cards = cardsDoc.cards || {};

  // 1) 分片：meta 声明的文件是否存在、能否解压、大小是否合理
  let missingShards = 0;
  let emptyShards = 0;
  const referenced = new Set();
  for (const [id, s] of Object.entries(sessions)) {
    if (!s.file) { problems.push({ level: 'warn', code: 'META_NO_FILE', message: `会话 ${id} 的 meta 缺少 file 字段` }); continue; }
    referenced.add(s.file);
    const full = path.join(indexDir, s.file);
    if (!fs.existsSync(full)) { missingShards += 1; continue; }
    try {
      const st = fs.statSync(full);
      if (st.size <= 32) emptyShards += 1;
    } catch { missingShards += 1; }
  }
  if (missingShards) problems.push({ level: 'error', code: 'SHARD_MISSING', message: `${missingShards} 个会话的分片文件不存在（索引需重建）` });
  if (emptyShards) problems.push({ level: 'warn', code: 'SHARD_EMPTY', message: `${emptyShards} 个分片是空的（会话可能还没有内容）` });

  // 2) 孤儿分片：磁盘上有、meta 里没有（可能是重建中途留下的）
  let orphanShards = [];
  try {
    orphanShards = fs.readdirSync(indexDir)
      .filter((f) => f.endsWith('.jsonl.gz') && !referenced.has(f));
  } catch { /* 目录读不了就当没有 */ }
  if (orphanShards.length) {
    problems.push({
      level: 'warn', code: 'SHARD_ORPHAN',
      message: `${orphanShards.length} 个分片没有被 meta 引用（多为重建中断的残留）`,
      files: orphanShards.slice(0, 8),
    });
  }

  // 3) 卡片与 meta 的覆盖关系
  const cardIds = Object.keys(cards);
  const metaIds = Object.keys(sessions);
  const importedCards = cardIds.filter((id) => !sessions[id]);
  const noCard = metaIds.filter((id) => !cards[id]);
  if (noCard.length) problems.push({ level: 'warn', code: 'CARD_MISSING', message: `${noCard.length} 个会话还没有会话卡（索引重建中或抽取失败）` });
  const importedNote = importedCards.length
    ? { level: 'info', code: 'CARD_IMPORTED', message: `${importedCards.length} 张卡片是从别的机器同步来的（本机无原文，get 只返回卡片）` }
    : null;

  // 4) 临时文件 / 备份堆积（这台机器曾堆过 170 个 notes 备份）
  let tmpFiles = [];
  let noteBackups = [];
  try {
    const names = fs.readdirSync(indexDir);
    tmpFiles = names.filter((f) => /\.tmp-\d+$/.test(f));
    noteBackups = names.filter((f) => /^notes\.json\.bak-/.test(f));
  } catch { /* 忽略 */ }
  if (tmpFiles.length) problems.push({ level: 'warn', code: 'TMP_LEFTOVER', message: `${tmpFiles.length} 个 .tmp-* 残留（写盘中断）`, files: tmpFiles.slice(0, 8) });
  if (noteBackups.length > 20) {
    problems.push({ level: 'info', code: 'BACKUP_PILE', message: `${noteBackups.length} 个 notes 备份堆积（每次写记忆都会留一份）` });
  }

  // 5) 体积与最大分片
  const sizes = [];
  for (const f of Object.keys(referenced)) {
    try { sizes.push({ file: f, bytes: fs.statSync(path.join(indexDir, f)).size }); } catch { /* 忽略 */ }
  }
  sizes.sort((a, b) => b.bytes - a.bytes);
  const totalBytes = indexSizeBytes(indexDir);

  // 6) 自动维护状态
  const autoState = auto.snapshot();
  if (autoState.lastError) problems.push({ level: 'error', code: 'AUTO_ERROR', message: `自动维护上次失败：${autoState.lastError}` });
  if (!autoState.enabled) problems.push({ level: 'info', code: 'AUTO_OFF', message: '后台自动维护已关闭（SESSION_INDEX_AUTO=0），新会话需手动 refresh' });

  if (fix) {
    const olderThan = Date.now() - 60 * 60 * 1000; // 只清 1 小时前的，避免误删正在写的
    for (const f of tmpFiles) {
      try {
        const full = path.join(indexDir, f);
        if (fs.statSync(full).mtimeMs < olderThan) { fs.unlinkSync(full); fixes.push(`删除临时文件 ${f}`); }
      } catch { /* 忽略 */ }
    }
    for (const f of orphanShards) {
      try {
        const full = path.join(indexDir, f);
        if (fs.statSync(full).mtimeMs < olderThan) { fs.unlinkSync(full); fixes.push(`删除孤儿分片 ${f}`); }
      } catch { /* 忽略 */ }
    }
    // notes 备份只留最近 5 份
    noteBackups.sort().reverse();
    for (const f of noteBackups.slice(5)) {
      try { fs.unlinkSync(path.join(indexDir, f)); fixes.push(`清理旧备份 ${f}`); } catch { /* 忽略 */ }
    }
  }

  const healthy = problems.filter((p) => p.level === 'error').length === 0;
  return {
    ok: true,
    healthy,
    indexDir,
    counts: {
      sessions: metaIds.length,
      cards: cardIds.length,
      importedCards: importedCards.length,
      missingShards,
      orphanShards: orphanShards.length,
      totalBytes,
    },
    builtAt: meta.builtAt || null,
    largestShards: sizes.slice(0, 5),
    autoIndex: autoState,
    problems,
    importedNote,
    fixes: fix ? fixes : undefined,
    hint: healthy
      ? (problems.length ? '索引可用，只有提示级问题；需要清理就带 fix: true 再调一次' : '索引健康')
      : '存在错误级问题：先跑 session_index_refresh {force:true} 重建，仍不行就删掉 ~/.dsh/session-index 让它自动重建',
  };
}

async function toolStage(args = {}) {
  const cfg = stageConfig();
  if (!cfg.enabled) {
    return { ok: false, code: 'STAGE_DISABLED', error: '暂存投递已被关闭', hint: '设置 SESSION_INDEX_STAGE=1 后重启 MCP 服务' };
  }
  const asError = (err) => (err instanceof StageError ? err.toJSON()
    : { ok: false, code: 'STAGE_FAILED', error: String(err.message || err) });

  if (args.status === true) {
    try {
      return await bridgeOverview(cfg);
    } catch (err) {
      return asError(err);
    }
  }

  const template = ['brief', 'decisions', 'detail'].includes(args.template) ? args.template : 'brief';
  const app = args.app || 'all';
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const workspace = typeof args.workspace === 'string' ? args.workspace.trim() : '';
  const limit = clamp(args.limit, 1, 20, 8);
  const maxChars = clamp(args.maxChars, 1000, 30000, 12000);
  const ids = Array.isArray(args.sessionIds) ? args.sessionIds.filter((x) => typeof x === 'string' && x.trim()) : [];

  // 源数据：指定会话时直接取卡片，否则用 brief 的最近/主题聚合
  let sessions;
  let memories;
  if (ids.length) {
    const cards = Object.values(freshCards().cards || {});
    const picked = cards.filter((c) => ids.some((p) => String(c.id || '').startsWith(p))).slice(0, 20);
    sessions = picked.map((c) => ({
      id: c.id, app: appOf(c), title: c.title, updatedAt: c.updatedAt, digest: c.digest,
      decisions: (c.decisions || []).slice(0, 3), questions: (c.questions || []).slice(0, 1),
      keywords: (c.keywords || []).slice(0, 6),
    }));
    memories = queryNotes(freshNotes(), { query, limit: 5 })
      .map((r) => ({ type: r.note.type, text: String(r.note.text).slice(0, 200), importance: r.note.importance }));
  } else {
    const brief = toolBrief({ query, app, workspace, limit, maxChars, includeMemory: true });
    sessions = brief.sessions || [];
    memories = brief.memories || [];
  }
  if (args.since || args.until) {
    const since = Number(args.since) || 0;
    const until = Number(args.until) || Infinity;
    sessions = sessions.filter((s) => (s.updatedAt || 0) >= since && (s.updatedAt || 0) <= until);
  }

  let hits = [];
  if (template === 'detail' && (query || ids.length)) {
    try {
      const sr = query ? await toolSearch({ query, app, workspace, mode: 'semantic', limit: 8, contextChars: 260 }) : null;
      hits = (sr?.results || []).map((r) => ({
        title: r.title, sessionId: r.sessionId, app: r.app, seq: r.seq,
        snippet: r.snippet || r.text || '',
      }));
    } catch (err) {
      log('stage detail 片段检索降级: ' + err.message);
    }
  }

  const payloadOpts = {
    notebook: args.notebook || cfg.defaultNotebook,
    hpath: args.hpath || cfg.defaultHpath,
    note: typeof args.note === 'string' ? args.note : '',
    template,
  };
  let doc;
  try {
    doc = buildStageDocument({ sessions, memories, hits }, {
      ...payloadOpts, query, title: typeof args.title === 'string' ? args.title : '', app,
    });
  } catch (err) {
    return asError(err);
  }
  const token = stageToken(doc, payloadOpts);

  // 第一步：只预览，绝不产生任何写操作
  if (!args.confirmToken) {
    return {
      ok: true, dryRun: true, staged: false, token,
      title: doc.title, chars: doc.chars, template,
      sessions: sessions.length, memories: memories.length, hits: hits.length,
      target: { service: cfg.url, notebook: payloadOpts.notebook, hpath: payloadOpts.hpath },
      preview: doc.markdown.slice(0, 1200),
      previewTruncated: doc.markdown.length > 1200,
      confirmWith: {
        query, app, workspace, template, title: doc.title, sessionIds: ids.length ? ids : undefined,
        since: args.since, until: args.until, limit, maxChars,
        notebook: args.notebook, hpath: args.hpath, note: args.note, confirmToken: token,
      },
      hint: '仅预览，未投递。确认无误后把 confirmWith 原样作为本工具参数再调一次；本工具永远不会自动写入思源笔记库',
    };
  }

  // 第二步：令牌必须匹配（防止预览 A、投递 B）
  if (String(args.confirmToken) !== token) {
    // 失配有两种原因：参数被改过（该拒绝），或者**索引在这几秒里自动刷新了**
    // （会话还在写，卡片/命中变了）。后者很常见，而这时队列里往往已经有同一篇 ——
    // 那就直接告诉人「已入队、没重复投递」，而不是甩一个 TOKEN_MISMATCH 让人反复重试。
    let dupOnMismatch = null;
    try { dupOnMismatch = await findDuplicate(cfg, doc); } catch { /* 桥不可达就照常拒绝 */ }
    if (dupOnMismatch) {
      return {
        ok: true, staged: false, alreadyQueued: true, id: dupOnMismatch.id,
        title: doc.title, chars: doc.chars, tokenMismatch: true,
        hint: '令牌失配（索引刚刷新），但待入库队列里已有同标题同字数的稿，未重复投递',
      };
    }
    return {
      ok: false, code: 'TOKEN_MISMATCH', staged: false,
      error: '确认令牌与当前内容不一致，已拒绝投递',
      hint: '索引可能刚更新或参数被改动。请重新预览，并原样带回新的 confirmWith',
    };
  }

  try {
    const dup = await findDuplicate(cfg, doc);
    if (dup) {
      return {
        ok: true, staged: false, alreadyQueued: true, id: dup.id, title: doc.title, chars: doc.chars,
        hint: '待入库队列里已有同标题同字数的稿，未重复投递',
      };
    }
    const result = await postStage(cfg, doc, payloadOpts);
    return { ...result, token, sessions: sessions.length, template, duplicateChecked: true };
  } catch (err) {
    return asError(err);
  }
}

const HANDLERS = {
  session_index_status: toolStatus,
  session_index_brief: toolBrief,
  session_index_list: toolList,
  session_index_related: toolRelated,
  session_index_thread: toolThread,
  session_index_search: toolSearch,
  session_index_get: toolGet,
  session_index_remember: toolRemember,
  session_index_recall: toolRecall,
  session_index_forget: toolForget,
  session_index_package: toolPackage,
  session_index_vectors: toolVectors,
  session_index_refresh: toolRefresh,
  session_index_todos: toolTodos,
  session_index_resume: toolResume,
  session_index_doctor: toolDoctor,
  session_index_stage: toolStage,
};

// ---------------------------------------------------------------- MCP 声明与自描述

const GUIDE_TEXT = `# dsh-session-index 使用说明

把 DSH 与 WorkBuddy 全部历史会话连成一份本地索引的 MCP 插件。
索引由服务在后台自动建立；新会话由文件事件自动识别，无需重启 DSH。

## 何时用哪个工具
- 会话开始 / 提到「之前、上次、继续、记得」：先调 session_index_brief。
- 找具体报错/命令：session_index_search（默认语义检索，只返回片段）。
- 看会话脉络：session_index_get 不传序号；取原文传 seqs / seqFrom / seqTo。
- 找关联会话：session_index_related；父子派生：session_index_thread。
- 列会话 / 按应用过滤：session_index_list（app = dsh / workbuddy / all）。
- 沉淀结论：session_index_remember；召回：session_index_recall；归档：session_index_forget。
- 打包分发：session_index_package（plugin / skill / all，自动生成 zip）。
- 查看索引与自动维护状态：session_index_status（autoIndex.watch 可看事件监听状态）。
- 会话整理成文档送进思源：session_index_stage（两步确认，只投递到「待入库」）。
- 探测思源桥服务与队列：session_index_stage {status:true}（只读）。

## 铁律
1. 逐级放大：brief → related/thread → search(片段) → get(原文)。
2. 不要直接读取 ~/.dsh/sessions 下的 .zstd 源文件。
3. 关键决策请用 search/get 回原文核对，会话卡只是规则抽取的导航摘要。
4. 语义检索默认排除系统注入快照；排查框架行为时才加 includeSystem: true。

## 自动行为
- 启动时若索引缺失，后台子进程自动全量构建，不阻塞 MCP 握手。
- fs.watch 递归监听会话目录：新会话写入停止后约数秒自动纳入；定时轮询兜底。
- 每次工具调用前做一次轻量 stat 检查，发现变化即时触发后台更新。
- 索引更新后发送 resources/prompts list_changed 通知，客户端无需重启即可刷新。
- SESSION_INDEX_AUTO=0 关闭全部自动维护；SESSION_INDEX_WATCH=0 只关闭事件监听。
- 安装包与技能包由 install.mjs 自动生成，也可用 session_index_package 随时重打。
`;

const INSTRUCTIONS = [
  '你是 DSH/WorkBuddy 全会话索引助手。索引在后台自动建立与增量刷新，新会话无需重启即可识别，通常无需调用 refresh。',
  '会话开始或用户提到「之前/上次/继续/记得」时，先调 session_index_brief 接上跨会话结论与长期记忆。',
  '找具体报错或命令用 session_index_search（默认语义检索，只返回片段）；看完整原文用 session_index_get 传 seqs。',
  '有新结论时用 session_index_remember 沉淀；需要分发时用 session_index_package 自动打包。',
  '要把会话整理成文档送进思源笔记时，用 session_index_stage：先不带 confirmToken 预览，用户确认后原样回传 confirmWith 才投递到「待入库」；绝不自动写库。',
  '完整说明见资源 session-index://guide，不要直接读取 .zstd 源会话文件。',
].join(' ');

const TOOLS = [
  { name: 'session_index_status', description: '查看索引状态、按应用统计、记忆数、检索模式、向量开关、自动维护与文件监听状态、已生成的分发包。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'session_index_brief', description: '【跨会话入口】聚合全部历史会话的结论 + 长期记忆成极简速览，新会话一次调用接上全部历史。传 query 则按主题聚合。', inputSchema: { type: 'object', properties: { query: { type: 'string' }, app: { type: 'string', description: 'dsh / workbuddy / all' }, workspace: { type: 'string' }, limit: { type: 'number' }, memoryLimit: { type: 'number' }, includeMemory: { type: 'boolean' }, maxChars: { type: 'number' } }, additionalProperties: false } },
  { name: 'session_index_list', description: '列出所有历史会话（id、app、标题、工作区、时间、记录数），支持 app/workspace/时间过滤与分页。', inputSchema: { type: 'object', properties: { app: { type: 'string' }, workspace: { type: 'string' }, since: { type: 'number' }, until: { type: 'number' }, limit: { type: 'number' }, offset: { type: 'number' } }, additionalProperties: false } },
  { name: 'session_index_related', description: '【会话关联】找出与某会话/主题相关的其它会话，给出共享路径、共同关键词、同类工具、父子关系等理由。', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, query: { type: 'string' }, app: { type: 'string' }, workspace: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
  { name: 'session_index_thread', description: '【会话血缘】返回上游祖先、下游派生子会话、同源兄弟。', inputSchema: { type: 'object', properties: { sessionId: { type: 'string', description: '必需，支持前缀' }, maxDepth: { type: 'number' } }, required: ['sessionId'], additionalProperties: false } },
  { name: 'session_index_search', description: '【语义检索】默认 semantic：同义扩展 + BM25 重排，纯本地零 token；keyword 精确 AND；hybrid/vector 可选向量，未配置自动降级。只返回片段。', inputSchema: { type: 'object', properties: { query: { type: 'string', description: '必需' }, mode: { type: 'string', description: 'semantic/keyword/hybrid/vector' }, app: { type: 'string' }, workspace: { type: 'string' }, sessionId: { type: 'string' }, role: { type: 'string' }, type: { type: 'string' }, includeSystem: { type: 'boolean' }, since: { type: 'number' }, until: { type: 'number' }, limit: { type: 'number' }, offset: { type: 'number' }, contextChars: { type: 'number' } }, required: ['query'], additionalProperties: false } },
  { name: 'session_index_get', description: '按需取某会话内容：不传序号返回骨架，传 seqs 或 seqFrom/seqTo 返回完整原文。', inputSchema: { type: 'object', properties: { sessionId: { type: 'string', description: '必需' }, seqs: { type: 'array', items: { type: 'number' } }, seqFrom: { type: 'number' }, seqTo: { type: 'number' }, maxChars: { type: 'number' } }, required: ['sessionId'], additionalProperties: false } },
  { name: 'session_index_remember', description: '【写入长期记忆】记一条决策/事实/偏好/待办/踩坑，之后 brief 与语义搜索自动召回。相同内容自动合并，写前备份。', inputSchema: { type: 'object', properties: { text: { type: 'string', description: '必需，最多 4000 字' }, type: { type: 'string', description: 'decision/fact/preference/todo/pitfall/note' }, tags: { type: 'array', items: { type: 'string' } }, importance: { type: 'number' }, sessionId: { type: 'string' }, app: { type: 'string' } }, required: ['text'], additionalProperties: false } },
  { name: 'session_index_recall', description: '【召回长期记忆】按关键词/类型/标签检索，按相关度+重要度+新鲜度排序。', inputSchema: { type: 'object', properties: { query: { type: 'string' }, type: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, limit: { type: 'number' }, includeArchived: { type: 'boolean' } }, additionalProperties: false } },
  { name: 'session_index_forget', description: '【归档/删除记忆】默认归档可恢复，purge=true 才物理删除。', inputSchema: { type: 'object', properties: { id: { type: 'string', description: '必需' }, purge: { type: 'boolean' } }, required: ['id'], additionalProperties: false } },
  { name: 'session_index_package', description: '【自动打包】无需手工压缩，一键生成可分发 zip。mode=plugin 打完整插件包，skill 打技能包（可直接导入 DSH 技能管理器），all 两种都打，status 查看已生成包。包内自动附 MANIFEST.json 与 INSTALL.md，且排除所有会话数据/索引/密钥。', inputSchema: { type: 'object', properties: { mode: { type: 'string', description: 'plugin / skill / all(默认) / status' } }, additionalProperties: false } },
  { name: 'session_index_vectors', description: '【可选向量层】查看/同步/查询向量缓存。未配置 SESSION_INDEX_EMBED_* 时本地语义检索照常工作且零成本。', inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'status/sync/search' }, query: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
  { name: 'session_index_todos', description: '【跨会话未完成事项】扫最近的会话记录，抽出 TODO / 待办 / 下一步 / 还没做 / 待验证 这类没做完的事（排除「已完成」语气），按项目分组并附会话与 seq。回答「我还有什么没做完」。', inputSchema: { type: 'object', properties: { limit: { type: 'number', description: '扫多少个最近会话，默认 20' }, perSession: { type: 'number', description: '每个会话最多取几条，默认 4' }, maxItems: { type: 'number', description: '总计上限，默认 40' }, app: { type: 'string' }, workspace: { type: 'string' }, since: { type: 'number' }, refresh: { type: 'boolean', description: '现读会话分片重算（默认读卡片里预抽好的）' } }, additionalProperties: false } },
  { name: 'session_index_resume', description: '【接续包】给会话 id 或主题，产出一段可直接粘进新会话的上下文（目标 / 已有结论 / 未完成 / 涉及路径 / 关键词 / 相关记忆）。传 stage:true 可一并投递到思源桥「待入库」。', inputSchema: { type: 'object', properties: { sessionId: { type: 'string', description: '会话 id，支持前缀' }, query: { type: 'string', description: '按主题挑最相关的 1~3 个会话' }, app: { type: 'string' }, workspace: { type: 'string' }, limit: { type: 'number' }, maxChars: { type: 'number' }, stage: { type: 'boolean', description: '投递到思源桥待入库（只入队，写入仍由人在界面确认）' }, title: { type: 'string' }, notebook: { type: 'string' }, hpath: { type: 'string' }, note: { type: 'string' } }, additionalProperties: false } },
  { name: 'session_index_doctor', description: '【索引体检】检查 meta / 分片 / 卡片三者一致性、孤儿分片、空分片、临时残留、备份堆积、体积与自动维护状态。fix=true 只清确定安全的东西（1 小时前的临时文件与孤儿分片、只留最近 5 份 notes 备份）。', inputSchema: { type: 'object', properties: { fix: { type: 'boolean' } }, additionalProperties: false } },
  { name: 'session_index_refresh', description: '手动立即刷新索引。注意：新会话已由文件事件自动识别，通常无需调用；仅改抽取规则或需即时生效时用。', inputSchema: { type: 'object', properties: { force: { type: 'boolean' } }, additionalProperties: false } },
  { name: 'session_index_stage', description: '【会话整理 → 思源桥待入库】把会话卡/结论/检索片段整理成 Markdown 文档。两步确认：不带 confirmToken 只返回预览与令牌，原样回传 confirmWith 才投递到思源桥 /api/stage；绝不自动写入思源笔记库。支持指定会话、主题、模板、落点与去重。status=true 只读探测服务与队列。', inputSchema: { type: 'object', properties: { status: { type: 'boolean', description: '只读：探测思源桥服务与待入库队列' }, query: { type: 'string', description: '主题词，按主题聚合会话' }, sessionIds: { type: 'array', items: { type: 'string' }, description: '指定会话 id（支持前缀），不传则按最近/主题取' }, app: { type: 'string', description: 'dsh / workbuddy / all' }, workspace: { type: 'string' }, since: { type: 'number' }, until: { type: 'number' }, template: { type: 'string', description: 'brief(默认) / decisions / detail' }, title: { type: 'string', description: '自定义文档标题；确认时请回传预览给出的 title' }, notebook: { type: 'string' }, hpath: { type: 'string', description: '目标目录，默认 /会话札记/思源' }, note: { type: 'string' }, limit: { type: 'number' }, maxChars: { type: 'number' }, confirmToken: { type: 'string', description: '预览返回的令牌；带上且匹配才真正投递' } }, additionalProperties: false } },
];

const PROMPTS = [
  { name: 'session-context', description: '【自动注入】把全部历史会话的结论与长期记忆整理成上下文', arguments: [{ name: 'query', description: '可选主题', required: false }, { name: 'limit', description: '会话数，默认 8', required: false }] },
  { name: 'resume-topic', description: '接着某个主题继续工作', arguments: [{ name: 'topic', description: '必需，主题词', required: true }] },
  { name: 'catch-up', description: '快速补课：最近会话结论 + 待办/决策类记忆', arguments: [] },
  { name: 'quickstart', description: '返回完整使用说明（等同资源 session-index://guide）', arguments: [] },
];

const RESOURCES = [
  { uri: 'session-index://guide', name: '插件使用说明', mimeType: 'text/markdown', description: 'MCP 客户端可自动读取的完整使用说明' },
  { uri: 'session-index://plugin.json', name: '插件能力清单', mimeType: 'application/json', description: '工具/提示词/资源/自动化配置的机器可读清单' },
  { uri: 'session-index://package', name: '分发包清单', mimeType: 'application/json', description: '已自动生成的插件包与技能包信息' },
  { uri: 'session-index://brief', name: '跨会话结论速览', mimeType: 'application/json', description: '最近/主题会话的结论摘要与长期记忆' },
  { uri: 'session-index://memory', name: '长期记忆库', mimeType: 'application/json', description: '全部未归档记忆' },
  { uri: 'session-index://status', name: '索引状态', mimeType: 'application/json', description: '会话数、卡片数、记忆数与自动维护状态' },
  { uri: 'session-index://cards', name: '全部会话卡', mimeType: 'application/json', description: '所有会话的精简卡片' },
];
const RESOURCE_TEMPLATES = [
  { uriTemplate: 'session-index://card/{id}', name: '单会话卡', mimeType: 'application/json', description: '按会话 id 读取一张会话卡' },
];

function buildPromptText(name, args = {}) {
  if (name === 'quickstart') return GUIDE_TEXT;
  const q = name === 'resume-topic' ? String(args.topic || '') : String(args.query || '');
  const limit = name === 'catch-up' ? 5 : clamp(args.limit, 1, 15, 8);
  const status = toolStatus();
  const brief = toolBrief({ query: q || undefined, limit, maxChars: 5000, includeMemory: true });
  const related = q ? toolRelated({ query: q, limit: 4 }) : null;
  const lines = [
    '# 跨会话上下文（dsh-session-index 自动生成）', '',
    `已索引 ${status.indexedSessions} 个会话 ${JSON.stringify(status.byApp)} / ${status.crossSessionCards} 张会话卡 / ${status.activeMemories} 条长期记忆。`,
    '', '## 长期记忆（优先遵守）',
    ...(brief.memories.length ? brief.memories.map((m) => `- [${m.type} · 重要度 ${m.importance}] ${m.text}`) : ['- （暂无，可用 session_index_remember 写入）']),
    '', `## 历史会话结论${q ? `（主题：${q}）` : ''}`,
    ...(brief.returned ? brief.sessions.flatMap((s) => [
      `### [${s.app}] ${s.title}`,
      ...(s.decisions || []).map((d) => `- ${d}`),
      ...(s.sharedPaths || []).slice(0, 2).map((p) => `- 涉及路径：${p}`),
    ]) : ['- （无相关历史）']),
  ];
  if (related?.returned) lines.push('', '## 相关会话', ...related.related.map((r) => `- ${r.title} — ${(r.reasons || []).join('；')}`));
  lines.push('', '## 使用约定',
    '- 以上只是导航摘要，关键决策请用 session_index_search / session_index_get 回原文核对。',
    '- 逐级放大：brief → related/thread → search（片段）→ get（原文）。',
    '- 不要直接读取 ~/.dsh/sessions 下的 .zstd 源文件。',
    '- 有新结论时调用 session_index_remember 写入长期记忆。');
  return lines.join('\n');
}

function readResource(uri) {
  if (uri === 'session-index://guide') return GUIDE_TEXT;
  if (uri === 'session-index://plugin.json') {
    try {
      return fs.readFileSync(new URL('./plugin.json', import.meta.url), 'utf8');
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  }
  if (uri === 'session-index://package') return json(listPacks());
  if (uri === 'session-index://brief') return json(toolBrief({ limit: 10, maxChars: 8000, includeMemory: true }));
  if (uri === 'session-index://memory') {
    const doc = freshNotes();
    return json({ total: doc.notes.length, notes: doc.notes.map(publicNote) });
  }
  if (uri === 'session-index://status') return json(toolStatus());
  if (uri === 'session-index://cards') {
    const cards = Object.values(freshCards().cards || {});
    return json({ total: cards.length, cards: cards.map((c) => ({ id: c.id, app: c.app, title: c.title, digest: c.digest, updatedAt: c.updatedAt })) });
  }
  if (uri.startsWith('session-index://card/')) {
    const id = decodeURIComponent(uri.slice('session-index://card/'.length));
    const doc = freshCards();
    return json(doc.cards?.[resolveCardId(doc, id)] || { error: '未找到会话卡' });
  }
  return null;
}

// ---------------------------------------------------------------- 协议层

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(req) {
  if (!req || typeof req !== 'object' || typeof req.method !== 'string') {
    rpcError(null, -32600, '无效请求');
    return;
  }
  const { id, method, params } = req;
  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      ok(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.has(requested) ? requested : '2024-11-05',
        capabilities: {
          tools: { listChanged: true },
          prompts: { listChanged: true },
          resources: { subscribe: false, listChanged: true },
        },
        serverInfo: { name: 'dsh-session-index', version: VERSION },
        instructions: INSTRUCTIONS,
      });
      return;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'ping':
      ok(id, {});
      return;
    case 'tools/list':
      ok(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      const fn = HANDLERS[name];
      if (!fn) {
        ok(id, { content: [{ type: 'text', text: JSON.stringify({ error: `未知工具: ${name}` }) }], isError: true });
        return;
      }
      // 每次调用前做轻量 stat 检查：有新会话立即触发后台更新，无需重启、无需等定时器
      if (!['session_index_status', 'session_index_refresh', 'session_index_vectors'].includes(name)) {
        try {
          auto.ensureFresh();
        } catch {
          // 检查失败不影响主流程
        }
        try {
          // 「有没有可用数据」要看**会话卡**而不只是 meta：
          // 另一台机器同步过来的会话卡只落在 cards.json 里，本机可能一个本地会话都还没有
          // （刚装完插件还没开过会话）。那时若只看 meta，会把所有工具都挡在
          // 「索引正在后台自动构建」后面 —— 拉来的数据等于白拉。
          const hasData = () => {
            try { if (Object.keys(freshMeta().sessions || {}).length > 0) return true; } catch { /* ignore */ }
            try { if (Object.keys(freshCards().cards || {}).length > 0) return true; } catch { /* ignore */ }
            return false;
          };
          if (!hasData()) {
            // 首次启动后台构建可能刚好还没落盘，给一个短窗口再判定，避免误报
            await new Promise((r) => setTimeout(r, 800));
            if (!hasData()) {
              ok(id, {
                content: [{ type: 'text', text: JSON.stringify({ error: '索引正在后台自动构建，请稍候几秒再试', autoIndex: auto.snapshot() }) }],
                isError: true,
              });
              return;
            }
          }
        } catch {
          // 继续正常处理
        }
      }
      try {
        ok(id, { content: [{ type: 'text', text: json(await fn(args)) }] });
      } catch (err) {
        log(`工具 ${name} 失败: ${err.message}`);
        ok(id, { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true });
      }
      return;
    }
    case 'prompts/list':
      ok(id, { prompts: PROMPTS });
      return;
    case 'prompts/get': {
      const name = params?.name;
      if (!PROMPTS.some((p) => p.name === name)) {
        rpcError(id, -32602, `未知提示词: ${name}`);
        return;
      }
      ok(id, { description: `跨会话上下文：${name}`, messages: [{ role: 'user', content: { type: 'text', text: buildPromptText(name, params?.arguments || {}) } }] });
      return;
    }
    case 'resources/list':
      ok(id, { resources: RESOURCES });
      return;
    case 'resources/templates/list':
      ok(id, { resourceTemplates: RESOURCE_TEMPLATES });
      return;
    case 'resources/read': {
      const uri = params?.uri;
      const text = readResource(String(uri || ''));
      if (text === null) {
        rpcError(id, -32602, `未知资源: ${uri}`);
        return;
      }
      const meta = RESOURCES.find((r) => r.uri === uri);
      ok(id, { contents: [{ uri, mimeType: meta?.mimeType || 'application/json', text }] });
      return;
    }
    default:
      if (id !== undefined) rpcError(id, -32601, `不支持的方法: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    rpcError(null, -32700, 'JSON 解析失败');
    return;
  }
  handle(req).catch((err) => {
    log('处理请求异常: ' + err.message);
    rpcError(req?.id ?? null, -32603, '内部错误');
  });
});
process.stdin.on('end', () => {
  auto.stop();
  process.exit(0);
});
auto.start();

/**
 * 首启自举：本地**一张会话卡都没有**、而远端是已知的时候，后台拉一次。
 *
 * 这解决的是「另一台终端装上插件就能直接用」：
 * 远端地址来自环境变量 / 包内默认 / 本机已保存（见 lib/sync.mjs 的 resolveRepo），
 * 所以新机器不用再手填地址；本地本来就没数据，拉取也不存在覆盖风险。
 * 用 SESSION_INDEX_SYNC_AUTO_PULL=0 可关掉。
 */
if (process.env.SESSION_INDEX_SYNC_AUTO_PULL !== '0') {
  void (async () => {
    try {
      const { syncStatus, syncPull } = await import('./lib/sync.mjs');
      const st = syncStatus(indexDir);
      if (!st.configured || st.local.cards > 0) return;
      log(`首启自举：本地还没有会话卡，正在从远端拉取（${st.repoSource}）…`);
      const r = await syncPull(indexDir);
      log(`首启自举完成：拉回 ${r.cards} 张会话卡 / ${r.notes} 条记忆`);
      notifyIndexUpdated({ rebuilt: 0 });
    } catch (err) {
      log('首启自举未完成（不影响其它功能）：' + ((err && err.message) || err));
    }
  })();
}

// 面板 HTTP 通道：侧栏「会话检索」面板直连本机读取索引。
// 它和 MCP 工具共用 lib/panel-api.mjs，所以面板看到的排序与 agent 搜到的完全一致。
// 端口占用就顺延，全占就放弃 —— 绝不影响 MCP 服务本身。
const httpPort = Number(process.env.SESSION_INDEX_HTTP_PORT ?? 8799);
if (Number.isFinite(httpPort) && httpPort !== 0) {
  try {
    const { startPanelHttp } = await import('./lib/http-api.mjs');
    startPanelHttp({
      indexDir,
      ports: [httpPort, ...httpPort + 1 <= httpPort + 9 ? Array.from({ length: 9 }, (_, i) => httpPort + 1 + i) : []],
      log,
    });
  } catch (err) {
    log('面板 HTTP 通道启动失败（不影响 MCP）：' + ((err && err.message) || err));
  }
}
log(`已启动 v${VERSION} | 会话源 ${sessionsRoot} | 索引 ${indexDir} | 事件监听与自动维护已开启`);
