/**
 * 本地语义化检索（零 LLM、零网络、零额外 token）。
 *
 * 不预建全库倒排索引（20k 条记录全量向量化太重），而是：
 *   1) 查询扩展：同义词/近义词 + 拼写变体，把「报错」扩到 error/bug/异常…
 *   2) 候选召回：原文命中原始词或扩展词即入选（比单纯子串匹配召回更全）
 *   3) BM25 重排：只在候选集上计算词频/逆文档频率/长度归一化，规模小、毫秒级
 *   4) 可选与向量检索结果做 RRF 融合
 * 这样既替换了「按命中次数排序」的朴素子串匹配，又保持纯本地、零成本。
 */
import { tokenize } from './cards.mjs';

const SYNONYM_GROUPS = [
  ['报错', '错误', '异常', '失败', '故障', 'error', 'bug', 'failed', 'failure', 'exception'],
  ['修复', '解决', '处理', '搞定', 'fix', 'fixed', 'resolve', 'resolved', 'workaround'],
  ['插件', '扩展', 'bundle', 'plugin', '扩展包'],
  ['配置', '设置', 'config', 'configure', 'setup', 'settings'],
  ['安装', '部署', 'install', 'deploy'],
  ['会话', '对话', '聊天', 'session', 'chat', 'conversation'],
  ['索引', '检索', '搜索', '查找', 'search', 'index', 'retrieve'],
  ['密钥', '凭证', '令牌', 'key', 'token', 'credential', 'apikey'],
  ['性能', '耗时', '速度', '成本', 'token', 'performance', 'latency'],
  ['周报', '报告', '汇总', 'report', 'summary'],
  ['思源', '笔记', 'siyuan', 'note'],
  ['证书', 'ca', 'cert', 'certificate'],
  ['删除', '清理', '移除', 'remove', 'delete', 'clean'],
  ['模型', 'model', 'llm', '大模型'],
  ['缓存', 'cache', '缓存索引'],
  ['终端', '命令行', 'shell', 'bash', 'powershell', 'pwsh'],
  ['路径', '目录', '文件', 'path', 'file', 'directory'],
  ['重启', '生效', 'restart', 'reload'],
];

/** 生成查询的原始词、扩展词与短语。 */
export function expandQuery(query) {
  const raw = String(query || '').trim();
  const terms = [...new Set(tokenize(raw))].slice(0, 12);
  const lower = raw.toLowerCase();
  const expanded = new Set();
  for (const t of terms) {
    for (const group of SYNONYM_GROUPS) {
      if (!group.some((g) => g === t || g.includes(t) || t.includes(g))) continue;
      for (const g of group) if (g !== t && !terms.includes(g)) expanded.add(g);
    }
  }
  // 英文词容错变体：删一个字符，覆盖拼写差异
  const variants = [];
  for (const t of terms) {
    if (/^[a-z][a-z0-9._-]{4,}$/.test(t)) {
      variants.push(t.slice(0, -1), t.slice(1));
    }
  }
  return {
    phrase: lower,
    terms,
    expanded: [...expanded].slice(0, 16),
    variants: [...new Set(variants)].slice(0, 8),
  };
}

/** 一条记录文本是否命中查询（原始词 / 扩展词 / 变体）。 */
export function matchesQuery(text, expandedQuery, includeVariants = true) {
  const lower = String(text || '').toLowerCase();
  let hits = 0;
  for (const t of expandedQuery.terms) if (lower.includes(t)) hits += 1;
  for (const t of expandedQuery.expanded) if (lower.includes(t)) hits += 1;
  if (includeVariants) for (const v of expandedQuery.variants) if (lower.includes(v)) hits += 1;
  return hits;
}

/**
 * 在候选集上做 BM25 重排。
 * @param {Array<object>} candidates 每条至少含 text
 * @param {object} expandedQuery expandQuery 的结果
 * @returns {Array<{item:object,score:number,matched:string[]}>}
 */
export function rankCandidates(candidates, expandedQuery) {
  if (candidates.length === 0) return [];
  const docs = candidates.map((item) => ({
    item,
    toks: tokenize(String(item.text || '').slice(0, 1200)),
  }));
  const df = new Map();
  for (const d of docs) {
    for (const t of new Set(d.toks)) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = docs.length;
  const avgdl = docs.reduce((s, d) => s + d.toks.length, 0) / Math.max(1, N);
  const k1 = 1.5;
  const b = 0.75;
  const out = [];

  for (const d of docs) {
    const tf = new Map();
    for (const t of d.toks) tf.set(t, (tf.get(t) || 0) + 1);
    const lenNorm = 1 - b + (b * d.toks.length) / Math.max(1, avgdl);
    let score = 0;
    const matched = new Set();

    for (const term of expandedQuery.terms) {
      const f = tf.get(term) || 0;
      if (!f) continue;
      const n = df.get(term) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += 3 * idf * ((f * (k1 + 1)) / (f + k1 * lenNorm));
      matched.add(term);
    }
    for (const term of expandedQuery.expanded) {
      const f = tf.get(term) || 0;
      if (!f) continue;
      const n = df.get(term) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += 1.1 * idf * ((f * (k1 + 1)) / (f + k1 * lenNorm));
      matched.add(term);
    }
    for (const v of expandedQuery.variants) {
      const f = tf.get(v) || 0;
      if (f) {
        score += 0.35;
        matched.add(v);
      }
    }
    if (expandedQuery.phrase && String(d.item.text || '').toLowerCase().includes(expandedQuery.phrase)) {
      score += 5;
    }
    if (d.item.kind === 'memory') score *= 1.25;
    if (score > 0) out.push({ item: d.item, score: +score.toFixed(3), matched: [...matched].slice(0, 8) });
  }
  return out.sort((a, b2) => b2.score - a.score);
}

/** 倒数排名融合（RRF），用于合并 BM25 与向量检索结果。 */
export function rrfMerge(rankLists, k = 60) {
  const scores = new Map();
  const holders = new Map();
  for (const list of rankLists) {
    list.forEach((entry, idx) => {
      const id = typeof entry === 'string' ? entry : entry.id;
      if (!holders.has(id)) holders.set(id, typeof entry === 'string' ? { id } : entry);
      scores.set(id, (scores.get(id) || 0) + 1 / (k + idx + 1));
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ ...holders.get(id), id, rrf: +score.toFixed(6) }));
}

/** 生成命中片段（命中点前后各取 contextChars 字）。 */
export function makeSnippet(text, expandedQuery, contextChars = 180) {
  const lower = String(text || '').toLowerCase();
  let pos = -1;
  for (const t of [...expandedQuery.terms, ...expandedQuery.expanded]) {
    const p = lower.indexOf(t);
    if (p !== -1 && (pos === -1 || p < pos)) pos = p;
  }
  if (pos === -1) return String(text || '').slice(0, contextChars * 2);
  const start = Math.max(0, pos - contextChars);
  const end = Math.min(text.length, pos + contextChars);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\r/g, '') + (end < text.length ? '…' : '');
}
