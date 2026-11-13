/**
 * 跨会话层：把每个会话压缩成一张「会话卡」，并据此计算会话之间的关联与血缘链。
 *
 * 纯规则抽取，零 LLM 调用、零额外 token 开销。所有输入都来自已经建好的索引记录，
 * 不重新解压源会话文件。
 */
import { isSystemInjected } from './extract.mjs';

const DECISION_HINT =
  /(结论|决定|最终|已修复|已完成|已解决|已确认|根因|原因是|问题在于|关键在于|方案是|建议|下一步|总结|因此|所以|确定|采用|改用|回滚|修复|不再|保持不变|需要注意|TL;DR|fixed|resolved|conclusion|decided|root cause|instead)/i;

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'you', 'are', 'not', 'but', 'from', 'have', 'has',
  'was', 'were', 'will', 'can', 'could', 'should', 'would', 'use', 'using', 'used', 'into', 'out',
  'its', 'they', 'them', 'their', 'what', 'when', 'where', 'which', 'who', 'how', 'all',
  'any', 'get', 'set', 'new', 'old', 'run', 'runs', 'done', 'true', 'false', 'null', 'undefined',
  'json', 'type', 'text', 'data', 'role', 'user', 'assistant', 'message', 'content', 'result',
  'file', 'path', 'name', 'value', 'string', 'line', 'code', 'error', 'log', 'test', 'check',
  '可以', '我们', '这个', '那个', '已经', '需要', '进行', '一个', '什么', '怎么', '如果', '因为',
  '但是', '然后', '现在', '时候', '这样', '那样', '这些', '那些', '以及', '并且', '还是', '或者',
  '一下', '一些', '这里', '那里', '之后', '之前', '里面', '出来', '起来', '没有', '不是', '就是',
  '所以', '因此', '于是', '而且', '并且', '通过', '关于', '对于', '根据', '按照', '使用', '进行',
]);

// 盘符前不能紧挨字母数字，避免把 https:// 里的 "s://" 当成 Windows 路径
const PATH_RE = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'`<>|)\],，。；;]+/g;
const QUOTED_PATH_RE = /["'`]([A-Za-z]:[\\/][^"'`\n]+)["'`]/g;
const FILE_RE = /\b[A-Za-z0-9_.-]+\.(?:md|json|ya?ml|ts|tsx|js|mjs|cjs|py|ps1|sh|txt|sql|html|css|svg|zstd|log|exe|dll|png|jpg|csv|xlsx)\b/gi;

const norm = (s) => String(s || '').toLowerCase().replace(/[\\/]+$/, '');

/** 中英文混合切词：英文按词，中文按 2-gram，用于关联计算而非展示。 */
export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const en = s.match(/[a-z][a-z0-9._-]{2,}/g) || [];
  const runs = s.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  const grams = [];
  for (const run of runs) {
    for (let i = 0; i < run.length - 1; i++) grams.push(run.slice(i, i + 2));
  }
  return [...en, ...grams].filter((t) => !STOP.has(t));
}

function topByCount(counter, limit) {
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([k]) => k);
}

function addAll(counter, values) {
  for (const v of values) {
    const key = String(v).trim();
    if (key) counter.set(key, (counter.get(key) || 0) + 1);
  }
}

/** 提取路径并归一化：过滤 URL、压缩转义产生的重复反斜杠、按大小写无关去重。 */
function extractPathHits(text) {
  const raw = [];
  for (const m of text.matchAll(QUOTED_PATH_RE)) raw.push(m[1]);
  for (const m of text.matchAll(PATH_RE)) raw.push(m[0]);
  const counter = new Map();
  const display = new Map();
  for (const item of raw) {
    const p = item
      .replace(/[.,;:)\]]+$/, '')
      .replace(/\\{2,}/g, '\\')
      .trim();
    if (p.includes('://') || /^https?:/i.test(p)) continue;
    if (p.length <= 3 || p.length >= 260) continue;
    const key = norm(p);
    counter.set(key, (counter.get(key) || 0) + 1);
    if (!display.has(key)) display.set(key, p);
  }
  return { counter, display };
}

function extractDecisions(records) {
  const out = [];
  const seen = new Set();
  const assistants = records.filter((r) => r.role === 'assistant');
  for (const r of assistants) {
    const sentences = r.text
      .split(/(?<=[。！？!?；;])|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 12 && s.length <= 240);
    for (const s of sentences) {
      if (!DECISION_HINT.test(s)) continue;
      const key = s.slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
      if (out.length >= 6) return out;
    }
  }
  if (out.length < 2) {
    for (const r of assistants.slice(-2)) {
      const first = r.text
        .split(/[。！？\n]/)
        .map((s) => s.trim())
        .find((s) => s.length >= 12);
      if (first && !seen.has(first.slice(0, 60))) {
        seen.add(first.slice(0, 60));
        out.push(first.slice(0, 200));
      }
    }
  }
  return out.slice(0, 6);
}

/**
 * 由会话元数据 + 已抽取的记录生成会话卡。
 * @returns {object} card
 */
export function buildCard(sessionMeta, records) {
  const questions = records
    .filter((r) => r.role === 'user' && !isSystemInjected(r))
    .slice(0, 3)
    .map((r) => r.text.replace(/\s+/g, ' ').trim().slice(0, 160))
    .filter(Boolean);

  const decisions = extractDecisions(records);

  const scanText = records.map((r) => r.text).join('\n').slice(0, 400000);
  const { counter: pathCounter, display: pathDisplay } = extractPathHits(scanText);
  const fileCounter = new Map();
  addAll(fileCounter, (scanText.match(FILE_RE) || []).map((f) => f.toLowerCase()));

  const toolCounter = new Map();
  addAll(toolCounter, records.filter((r) => r.role === 'tool-call' && r.tool).map((r) => r.tool));

  const keywordCounter = new Map();
  addAll(keywordCounter, tokenize([sessionMeta.title, ...questions, ...decisions].join('\n').slice(0, 5000)));
  addAll(keywordCounter, tokenize(topByCount(fileCounter, 6).join(' ')));
  // 反复出现的词优先，单次碎片降级补足，避免「的文 / 效表」这类切分噪声占位
  const ranked = [...keywordCounter.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  );
  const keywords = [
    ...new Set([
      ...ranked.filter(([, c]) => c >= 2).slice(0, 14).map(([k]) => k),
      ...ranked.filter(([, c]) => c === 1).slice(0, 4).map(([k]) => k),
    ]),
  ].slice(0, 16);

  const paths = topByCount(pathCounter, 8).map((k) => pathDisplay.get(k)).filter(Boolean);
  const files = topByCount(fileCounter, 8);
  const tools = topByCount(toolCounter, 8);

  return {
    id: sessionMeta.id,
    title: sessionMeta.title,
    workspace: sessionMeta.workspace,
    app: sessionMeta.app || 'dsh',
    updatedAt: sessionMeta.updatedAt,
    recordCount: sessionMeta.records ?? records.length,
    parentSession: sessionMeta.parentSession || null,
    questions,
    decisions,
    paths,
    files,
    tools,
    keywords,
    digest: decisions[0]?.slice(0, 160) || sessionMeta.title,
  };
}

function scoreCards(seed, other) {
  const seedPaths = new Set(seed.paths.map(norm));
  const otherPaths = new Set(other.paths.map(norm));
  const sharedPaths = [...seedPaths].filter((p) => otherPaths.has(p)).slice(0, 4);

  const seedKeywords = new Set(seed.keywords);
  const sharedKeywords = other.keywords.filter((k) => seedKeywords.has(k)).slice(0, 6);

  const seedTools = new Set(seed.tools);
  const sharedTools = other.tools.filter((t) => seedTools.has(t)).slice(0, 3);

  let score = sharedPaths.length * 3 + sharedKeywords.length * 1 + sharedTools.length * 0.5;
  const reasons = [];
  if (sharedPaths.length) reasons.push(`共享路径 ${sharedPaths.join(' / ')}`);
  if (sharedKeywords.length) reasons.push(`共同关键词 ${sharedKeywords.join('、')}`);
  if (sharedTools.length) reasons.push(`同类工具 ${sharedTools.join('、')}`);

  const kinship =
    other.parentSession === seed.id ||
    seed.parentSession === other.id ||
    (seed.parentSession && seed.parentSession === other.parentSession);
  if (kinship) {
    score += 5;
    reasons.push('存在父子/同源会话关系');
  }
  if (seed.workspace && seed.workspace === other.workspace) {
    score += 0.5;
    reasons.push('同一工作区');
  }
  return { score, reasons, sharedPaths, sharedKeywords, sharedTools };
}

function filterByWorkspace(cards, workspace) {
  if (!workspace) return cards;
  const w = workspace.toLowerCase();
  return cards.filter((c) => String(c.workspace || '').toLowerCase().includes(w));
}

/** 找出与某个会话最相关的其它会话。 */
export function relatedTo(cardsDoc, seedId, { limit = 6, workspace = '' } = {}) {
  const all = Object.values(cardsDoc.cards || {});
  const seed = cardsDoc.cards?.[seedId];
  if (!seed) return { error: `未找到会话卡 ${seedId}` };
  const rows = filterByWorkspace(all, workspace)
    .filter((c) => c.id !== seedId)
    .map((c) => ({ card: c, ...scoreCards(seed, c) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.card.updatedAt - a.card.updatedAt)
    .slice(0, Math.min(20, Math.max(1, limit)));
  return {
    seedId,
    seedTitle: seed.title,
    returned: rows.length,
    related: rows.map((r) => ({
      id: r.card.id,
      title: r.card.title,
      updatedAt: r.card.updatedAt,
      score: +r.score.toFixed(1),
      reasons: r.reasons,
      sharedPaths: r.sharedPaths,
      sharedKeywords: r.sharedKeywords,
    })),
  };
}

/** 按主题词给会话打分（用于「关于 X 的所有历史结论」）。 */
export function matchQuery(cardsDoc, query, { limit = 8, workspace = '' } = {}) {
  const terms = tokenize(query);
  const q = query.toLowerCase();
  const rows = filterByWorkspace(Object.values(cardsDoc.cards || {}), workspace)
    .map((c) => {
      const kws = new Set(c.keywords);
      const hitKeywords = terms.filter((t) => kws.has(t));
      const hitPaths = c.paths.filter((p) => norm(p).includes(q));
      const titleHit = c.title.toLowerCase().includes(q) ? 1 : 0;
      const decisionHit = c.decisions.filter((d) => d.toLowerCase().includes(q)).length;
      const score = hitKeywords.length + hitPaths.length * 3 + titleHit * 4 + decisionHit * 2;
      return { card: c, score, hitKeywords: [...new Set(hitKeywords)].slice(0, 6), hitPaths: hitPaths.slice(0, 3) };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.card.updatedAt - a.card.updatedAt)
    .slice(0, Math.min(30, Math.max(1, limit)));
  return rows;
}

/** 父子会话血缘链：上游祖先 + 下游派生 + 同源兄弟。 */
export function threadOf(cardsDoc, sessionId, { maxDepth = 6 } = {}) {
  const cards = cardsDoc.cards || {};
  if (!cards[sessionId]) return { error: `未找到会话卡 ${sessionId}` };
  const seen = new Set([sessionId]);

  const ancestors = [];
  let cur = cards[sessionId].parentSession;
  let depth = 1;
  while (cur && cards[cur] && !seen.has(cur) && depth <= maxDepth) {
    seen.add(cur);
    ancestors.push({ id: cur, title: cards[cur].title, updatedAt: cards[cur].updatedAt, depth: -depth });
    cur = cards[cur].parentSession;
    depth += 1;
  }

  const childrenByParent = new Map();
  for (const c of Object.values(cards)) {
    if (!c.parentSession) continue;
    if (!childrenByParent.has(c.parentSession)) childrenByParent.set(c.parentSession, []);
    childrenByParent.get(c.parentSession).push(c);
  }

  const descendants = [];
  let frontier = [sessionId];
  let d = 1;
  while (frontier.length && d <= maxDepth) {
    const next = [];
    for (const p of frontier) {
      for (const c of childrenByParent.get(p) || []) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        descendants.push({ id: c.id, title: c.title, updatedAt: c.updatedAt, depth: d });
        next.push(c.id);
      }
    }
    frontier = next;
    d += 1;
  }

  const parent = cards[sessionId].parentSession;
  const siblings = parent
    ? (childrenByParent.get(parent) || [])
        .filter((c) => c.id !== sessionId)
        .slice(0, 10)
        .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }))
    : [];

  return {
    sessionId,
    title: cards[sessionId].title,
    ancestors: ancestors.reverse(),
    descendants,
    siblings,
    chainLength: ancestors.length + descendants.length + 1,
  };
}
