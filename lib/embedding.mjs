/**
 * 可选的向量语义检索（OpenAI 兼容 /embeddings 端点）。
 *
 * 默认完全关闭、零成本；只有同时配置以下三个环境变量才启用：
 *   SESSION_INDEX_EMBED_URL    baseURL，如 https://yanfa.scedu.tech/v1
 *   SESSION_INDEX_EMBED_KEY    API Key（只在环境变量里，绝不写入任何文件/日志）
 *   SESSION_INDEX_EMBED_MODEL  嵌入模型名
 *
 * 只对「会话卡 + 长期记忆」这类高价值短文本建向量（几十~几百条），
 * 不对 2 万条原始记录逐条嵌入，避免昂贵调用。结果缓存到 vectors.json，按文本 hash 增量更新。
 */
import { createHash } from 'node:crypto';

import { loadDoc, saveDoc } from './index-store.mjs';

const FILE = 'vectors.json';
const empty = () => ({ version: 1, model: null, dims: 0, updatedAt: null, items: {} });

export function embeddingConfig(env = process.env) {
  const url = String(env.SESSION_INDEX_EMBED_URL || '').trim().replace(/\/+$/, '');
  const key = String(env.SESSION_INDEX_EMBED_KEY || '').trim();
  const model = String(env.SESSION_INDEX_EMBED_MODEL || '').trim();
  return { enabled: Boolean(url && key && model), url, key, model };
}

const hashText = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 24);

export function loadVectors(indexDir) {
  const doc = loadDoc(indexDir, FILE, empty);
  if (!doc.items || typeof doc.items !== 'object') doc.items = {};
  return doc;
}

export function saveVectors(indexDir, doc) {
  doc.version = 1;
  doc.updatedAt = new Date().toISOString();
  saveDoc(indexDir, FILE, doc, { backup: false });
}

/** 由会话卡生成可嵌入文本块。 */
export function cardChunks(cardsDoc) {
  return Object.values(cardsDoc.cards || {}).map((c) => ({
    id: `card:${c.id}`,
    sessionId: c.id,
    app: c.app || 'dsh',
    kind: 'card',
    title: c.title,
    text: [
      c.title,
      (c.questions || []).join('；'),
      (c.decisions || []).join('；'),
      (c.keywords || []).join(' '),
      (c.paths || []).join(' '),
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 1500),
  }));
}

async function postEmbeddings(input, cfg, timeoutMs = 20000) {
  const res = await fetch(`${cfg.url}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.key}`,
    },
    body: JSON.stringify({ model: cfg.model, input }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
  const data = await res.json();
  const rows = Array.isArray(data?.data) ? data.data : [];
  if (rows.length !== input.length) throw new Error('embeddings 返回数量不匹配');
  return rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((r) => r.embedding);
}

/** 增量同步向量缓存：只嵌入缺失或文本变化的块。 */
export async function syncVectors(indexDir, chunks, cfg, batchSize = 16) {
  if (!cfg.enabled) return { ok: false, reason: '未配置 embedding，已跳过' };
  const doc = loadVectors(indexDir);
  doc.model = cfg.model;
  const missing = [];
  for (const c of chunks) {
    const h = hashText(c.text);
    if (!doc.items[h]) missing.push({ h, chunk: c });
  }
  let embedded = 0;
  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    const vecs = await postEmbeddings(batch.map((m) => m.chunk.text), cfg);
    batch.forEach((m, j) => {
      doc.items[m.h] = {
        id: m.chunk.id,
        sessionId: m.chunk.sessionId,
        app: m.chunk.app,
        kind: m.chunk.kind,
        title: m.chunk.title,
        text: m.chunk.text.slice(0, 300),
        vec: vecs[j],
      };
    });
    embedded += batch.length;
  }
  doc.dims = Object.values(doc.items)[0]?.vec?.length || doc.dims || 0;
  saveVectors(indexDir, doc);
  return { ok: true, embedded, cached: chunks.length - embedded, total: Object.keys(doc.items).length, model: cfg.model };
}

/** 对查询做嵌入并按余弦相似度排序（只读缓存，不触发网络写入）。 */
export async function vectorRank(indexDir, query, cfg, topK = 20) {
  if (!cfg.enabled) return { ok: false, reason: '未配置 embedding' };
  const doc = loadVectors(indexDir);
  const items = Object.values(doc.items);
  if (items.length === 0) return { ok: false, reason: '向量缓存为空，先调用 refresh 同步' };
  const [qv] = await postEmbeddings([String(query)], cfg);
  const rows = items.map((it) => ({ ...it, score: cosine(qv, it.vec) }));
  rows.sort((a, b) => b.score - a.score);
  return { ok: true, model: cfg.model, returned: Math.min(topK, rows.length), results: rows.slice(0, topK) };
}

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function vectorStats(indexDir) {
  const doc = loadVectors(indexDir);
  const items = Object.values(doc.items);
  return {
    enabled: false,
    model: doc.model,
    dims: doc.dims,
    cached: items.length,
    byKind: items.reduce((m, it) => ({ ...m, [it.kind]: (m[it.kind] || 0) + 1 }), {}),
    updatedAt: doc.updatedAt,
  };
}
