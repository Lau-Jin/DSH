/**
 * 会话整理文档 → 思源桥「待入库」队列（服务层 + 仓储层）。
 *
 * 边界（刻意为之）：
 *   - 本模块**不读索引、不碰会话文件**，源数据由 server.mjs 控制器组装后传入；
 *   - 只调用 /api/status、/api/stage（GET/POST），**绝不调用 /api/stage/commit**；
 *     写进思源笔记库这一步永远留给人在思源桥界面确认；
 *   - 只允许回环地址，避免工具被误用来打任意内网服务。
 *
 * 两步确认（无状态）：预览返回 token = sha256(标题 + 落点 + 正文)。
 * 确认时按同一组参数重新渲染、重算 token，一致才真正投递，防止「预览 A、投递 B」。
 */
import { createHash } from 'node:crypto';

const DEFAULT_PORT = 5599;
const MAX_MARKDOWN = 60000;
const DEFAULT_TIMEOUT = 5000;

/** 配置集中解析：全部来自环境变量，启动时不需要外部依赖。 */
export function stageConfig(env = process.env) {
  const port = String(env.SIYUAN_BRIDGE_PORT || DEFAULT_PORT);
  const url = String(env.SIYUAN_BRIDGE_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  return {
    url,
    enabled: env.SESSION_INDEX_STAGE !== '0',
    timeoutMs: Math.min(60000, Math.max(1000, Number(env.SESSION_INDEX_STAGE_TIMEOUT_MS) || DEFAULT_TIMEOUT)),
    defaultHpath: env.SESSION_INDEX_STAGE_HPATH || '/会话札记/思源',
    defaultNotebook: env.SESSION_INDEX_STAGE_NOTEBOOK || '思源桥',
    maxMarkdown: MAX_MARKDOWN,
  };
}

/** 拒绝非回环地址：这个工具只应该跟本机的思源桥说话。 */
export function assertLoopback(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('SIYUAN_BRIDGE_URL 不是合法 URL');
  }
  const host = parsed.hostname;
  const ok = parsed.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]');
  if (!ok) throw new Error('思源桥地址必须是本机回环地址（127.0.0.1 / localhost）');
  return parsed;
}

/** 类型化错误：客户端只看到规范化结构，不暴露堆栈与内部细节。 */
export class StageError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'StageError';
    this.code = code;
    this.detail = detail;
  }
  toJSON() {
    return { ok: false, code: this.code, error: this.message, detail: this.detail };
  }
}

const clean = (s, max = 200) => String(s ?? '').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, max);
const stamp = (ts) => {
  if (!ts) return '时间未知';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '时间未知' : d.toLocaleString('zh-CN', { hour12: false });
};

/** 渲染会话整理文档：纯函数，无副作用，便于单测。 */
export function buildStageDocument(sources = {}, opts = {}) {
  const template = ['brief', 'decisions', 'detail'].includes(opts.template) ? opts.template : 'brief';
  const sessions = Array.isArray(sources.sessions) ? sources.sessions : [];
  const memories = Array.isArray(sources.memories) ? sources.memories : [];
  const hits = Array.isArray(sources.hits) ? sources.hits : [];
  const topic = clean(opts.query || '', 60);
  const date = new Date();
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const hhmm = `${String(date.getHours()).padStart(2, '0')}时${String(date.getMinutes()).padStart(2, '0')}分`;
  const title = clean(opts.title || `会话整理 · ${day} ${hhmm} · ${topic || `${sessions.length} 个会话`}`, 120)
    || `会话整理 · ${day} ${hhmm}`;

  const dshCount = sessions.filter((s) => (s.app || 'dsh') === 'dsh').length;
  const wbCount = sessions.length - dshCount;
  const lines = [
    `# ${title}`,
    '',
    `> 来源：session-index · ${sessions.length} 个会话（DSH ${dshCount} / WorkBuddy ${wbCount}）· 生成于 ${stamp(date.getTime())}`,
    `> 模板：${template} · 范围：${opts.app || 'all'}${topic ? ` · 主题：${topic}` : ''}`,
    '> 本稿仅投递到思源桥「待入库」队列，**未写入笔记库**，需人工确认。',
    '',
  ];

  if (!sessions.length && !memories.length && !hits.length) {
    lines.push('（没有可整理的内容：换个主题词、放宽时间范围，或先确认索引已建好）', '');
  }

  if (sessions.length) {
    if (template === 'decisions') {
      lines.push('## 结论与决策', '');
      let n = 0;
      for (const s of sessions) {
        for (const d of (s.decisions || [])) {
          lines.push(`- ${String(d).replace(/\s+/g, ' ').trim()}  — ${clean(s.title, 60)}`);
          n++;
        }
      }
      if (!n) lines.push('（这些会话卡里没有抽取到结论，可改用 template=detail 看原文片段）');
      lines.push('');
    } else {
      lines.push('## 会话速览', '');
      sessions.forEach((s, i) => {
        lines.push(`### ${i + 1}. ${clean(s.title || '（无标题）', 90)}`, '');
        lines.push(`- 应用：${s.app || 'dsh'} · 更新：${stamp(s.updatedAt)} · 会话：\`${clean(s.id, 48)}\``);
        if (s.workspace) lines.push(`- 工作区：\`${clean(s.workspace, 90)}\``);
        if (s.digest) lines.push(`- 摘要：${String(s.digest).replace(/\s+/g, ' ').trim()}`);
        if ((s.decisions || []).length) {
          lines.push('- 结论：');
          for (const d of s.decisions) lines.push(`  - ${String(d).replace(/\s+/g, ' ').trim()}`);
        }
        if ((s.questions || []).length) lines.push(`- 提问：${s.questions.map((q) => String(q).replace(/\s+/g, ' ').trim()).join('；')}`);
        if ((s.keywords || []).length) lines.push(`- 关键词：${s.keywords.join('、')}`);
        lines.push('');
      });
    }
  }

  if (memories.length && template !== 'decisions') {
    lines.push('## 长期记忆', '');
    for (const m of memories) lines.push(`- [${m.type || 'note'} · 重要度 ${m.importance ?? 0}] ${String(m.text).replace(/\s+/g, ' ').trim()}`);
    lines.push('');
  } else if (memories.length) {
    const decisions = memories.filter((m) => ['decision', 'fact', 'pitfall'].includes(m.type));
    if (decisions.length) {
      lines.push('## 相关长期记忆', '');
      for (const m of decisions) lines.push(`- [${m.type}] ${String(m.text).replace(/\s+/g, ' ').trim()}`);
      lines.push('');
    }
  }

  if (template === 'detail' && hits.length) {
    lines.push('## 检索命中片段', '');
    for (const h of hits) {
      lines.push(`**${clean(h.title || h.sessionId || '片段', 80)}** · ${h.app || ''} · seq ${h.seq ?? '-'}`, '');
      lines.push('```text', String(h.snippet || h.text || '').trim(), '```', '');
    }
  }

  lines.push('---', '', `共 ${sessions.length} 个会话 · ${memories.length} 条记忆 · ${hits.length} 个片段`);
  const markdown = lines.join('\n');
  if (markdown.length > MAX_MARKDOWN) {
    throw new StageError('DOC_TOO_LARGE', `文档超过 ${MAX_MARKDOWN} 字上限`, `${markdown.length} 字，请调小 limit / maxChars`);
  }
  return { title, markdown, chars: markdown.length };
}

/** 预览令牌：把标题、落点与正文一起绑定，避免确认时内容被换掉。 */
export function stageToken(doc, opts = {}) {
  const raw = [doc.title, opts.notebook || '', opts.hpath || '', opts.note || '', doc.markdown].join('\n');
  return createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

async function requestJSON(url, path, { method = 'GET', body, timeoutMs } = {}) {
  assertLoopback(url);
  let res;
  try {
    res = await fetch(url + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new StageError('BRIDGE_UNREACHABLE', '思源桥服务不可达', `${url}${path} · ${err.name}: ${err.message}`);
  }
  const text = await res.text().catch(() => '');
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new StageError('BRIDGE_BAD_RESPONSE', '思源桥返回了非 JSON 响应', `${path} · HTTP ${res.status}`);
  }
  if (!res.ok) {
    const msg = data.error || data.message || `HTTP ${res.status}`;
    throw new StageError('BRIDGE_ERROR', '思源桥拒绝了请求', `${path} · ${msg}`);
  }
  return data;
}

/** 只读探测：服务是否活着、队列里有多少篇、自动接入目录在哪。 */
export async function bridgeOverview(cfg) {
  const [status, queue, autostage] = await Promise.all([
    requestJSON(cfg.url, '/api/status', { timeoutMs: cfg.timeoutMs }),
    requestJSON(cfg.url, '/api/stage', { timeoutMs: cfg.timeoutMs }),
    requestJSON(cfg.url, '/api/autostage', { timeoutMs: cfg.timeoutMs }).catch(() => null),
  ]);
  return {
    ok: true,
    service: cfg.url,
    kernel: status.kernel || null,
    queued: Array.isArray(queue.items) ? queue.items.length : (status.staged ?? 0),
    discarded: queue.discarded ?? 0,
    autoStageDir: autostage?.dir || null,
    autoStageEnabled: autostage?.enabled ?? null,
    note: '只读取状态，未做任何写入',
  };
}

/** 按「标题 + 字数」检查队列里是否已有同一份稿，避免重复入队。 */
export async function findDuplicate(cfg, doc) {
  const queue = await requestJSON(cfg.url, '/api/stage', { timeoutMs: cfg.timeoutMs });
  const items = Array.isArray(queue.items) ? queue.items : [];
  return items.find((it) => String(it.title || '').trim() === doc.title && Number(it.chars) === doc.chars) || null;
}

/** 唯一允许的写操作：投递到待入库队列。绝不 commit。 */
export async function postStage(cfg, doc, opts = {}) {
  const payload = {
    title: doc.title,
    markdown: doc.markdown,
    notebook: opts.notebook || cfg.defaultNotebook,
    hpath: opts.hpath || cfg.defaultHpath,
    note: clean(opts.note || `session-index · ${opts.template || 'brief'} · 预览确认后投递`, 200),
  };
  const result = await requestJSON(cfg.url, '/api/stage', {
    method: 'POST', body: payload, timeoutMs: cfg.timeoutMs,
  });
  return {
    ok: true, staged: true,
    id: result.id || null, title: result.title || doc.title,
    chars: doc.chars, notebook: payload.notebook, hpath: payload.hpath,
    next: '在思源桥「待入库」里勾选写入；本工具不会自动写库',
  };
}
