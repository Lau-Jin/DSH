/**
 * dsh-session-index v2.3.0 — 零依赖 MCP 插件，装上即用、新会话免重启识别
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
import { loadNotes, saveNotes, addNote, queryNotes, removeNote, noteChunks, notesStats } from './lib/notes.mjs';
import { expandQuery, matchesQuery, rankCandidates, rrfMerge, makeSnippet } from './lib/semantic.mjs';
import { embeddingConfig, syncVectors, vectorRank, cardChunks, vectorStats } from './lib/embedding.mjs';
import { pack, packAll, listPacks } from './lib/pack.mjs';

const { sessionsRoot, indexDir, workbuddyProjectsDir } = defaultPaths();
const VERSION = '2.3.0';
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
  let rows = filterByApp(Object.values(meta.sessions), args.app).filter((s) => {
    if (workspace && !String(s.workspace || '').toLowerCase().includes(workspace)) return false;
    const t = s.updatedAt || 0;
    return t >= since && t <= until;
  });
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
    })),
    hint: '用 session_index_get 看骨架、session_index_related 找关联；app 可填 dsh / workbuddy / all',
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
function cardDocs(doc, app) {
  return Object.values(doc.cards || {}).filter((c) => matchApp(appOf(c), app)).map((c) => ({
    kind: 'card', sessionId: c.id, app: appOf(c), title: c.title, role: 'card', t: 'card',
    ts: c.updatedAt, i: -1, text: [c.title, ...(c.questions || []), ...(c.decisions || [])].join('\n'),
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
  if (candidates.length === 0) fail('没有符合过滤条件的会话，先用 session_index_list 看看');
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
    ranked = docs.map((it) => ({
      item: it,
      score: eq.terms.reduce((n, t) => n + (it.text.toLowerCase().split(t).length - 1), 0),
      matched: eq.terms,
    })).sort((a, b) => b.score - a.score || b.item.ts - a.item.ts);
  } else {
    ranked = rankCandidates([...docs, ...noteDocs(), ...cardDocs(cardsDoc, app)], eq);
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
  return {
    query: args.query, mode: degraded ? 'semantic' : mode, degraded,
    degradeReason: degraded ? '未配置 embedding，已降级为本地语义检索（零 token）' : undefined,
    expandedTerms: mode === 'keyword' ? undefined : eq.expanded,
    total: ranked.length, returned: page.length, offset,
    sessionsScanned: candidates.length, app, systemIncluded: includeSystem, vectorInfo, results: page,
    hint: '默认语义模式：同义扩展召回 + BM25 重排，只返回片段。完整原文用 session_index_get',
  };
}

// ---------------------------------------------------------------- 工具：原文与记忆

function toolGet(args = {}) {
  const meta = freshMeta();
  const s = resolveSession(meta, args.sessionId);
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
  { name: 'session_index_refresh', description: '手动立即刷新索引。注意：新会话已由文件事件自动识别，通常无需调用；仅改抽取规则或需即时生效时用。', inputSchema: { type: 'object', properties: { force: { type: 'boolean' } }, additionalProperties: false } },
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
          if (Object.keys(freshMeta().sessions || {}).length === 0) {
            // 首次启动后台构建可能刚好还没落盘，给一个短窗口再判定，避免误报
            await new Promise((r) => setTimeout(r, 800));
            if (Object.keys(freshMeta().sessions || {}).length === 0) {
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
log(`已启动 v${VERSION} | 会话源 ${sessionsRoot} | 索引 ${indexDir} | 事件监听与自动维护已开启`);
