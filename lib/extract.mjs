/**
 * 把 DSH 的原始事件流压缩成「可检索记录」。
 * 只保留有信息价值的事件（对话、工具调用与结果、压缩摘要等），
 * 跳过 step/start、job/*、request/header 这类高频噪声，避免索引膨胀。
 */

const KEEP = new Set([
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'system/message',
  'developer/message',
  'compaction/summary',
  'compaction/start',
  'command/run',
  'command/done',
  'model/selection',
  'llm/retry',
  'session-log-deepseek/delivery-accepted',
]);

const ROLE_BY_TYPE = {
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/call': 'tool-call',
  'tool/result': 'tool-result',
  'system/message': 'system',
  'developer/message': 'developer',
  'compaction/summary': 'summary',
  'compaction/start': 'summary',
  'command/run': 'command',
  'command/done': 'command',
  'model/selection': 'meta',
  'llm/retry': 'meta',
  'session-log-deepseek/delivery-accepted': 'meta',
};

const MAX_TOOL_ARGS = 8000;
const MAX_RECORD_CHARS = 30000;

/** DSH 自动注入的 user/message 的 source.kind；检索时默认排除，标题也不取它们。 */
const INJECTED_KINDS = new Set([
  'time-context',
  'runtime-context',
  'user-approval',
  'environment',
  'system',
  'tool-registry',
  'compaction',
  'system-reminder', // WorkBuddy 会话里剥除 user-context 注入后留下的标记
]);

/** 系统自动注入的短消息（无 source 字段时的兜底判定）。 */
const SYSTEMIC_SHORT = /approval policy|approval mode|permission changed|sandbox mode/i;
/** 无论长短都判定为系统日志/注入块。 */
const SYSTEMIC_ANY =
  /^time:\s*\d{4}-|^source:\s*host|^<system|^<environment|^Current runtime context|^System reminder|^Environment snapshot|^Time sampled while preparing/i;

/** 递归收集 content 数组里的纯文本块；跳过 reasoning / 流式 chunk 噪声。 */
function collectTextBlocks(node, out, depth = 0) {
  if (node == null || depth > 6 || out.length >= 60) return;
  if (Array.isArray(node)) {
    for (const item of node) collectTextBlocks(item, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  if (node.type === 'text' && typeof node.text === 'string') {
    out.push(node.text);
    return;
  }
  if (node.type === 'reasoning' || node.type === 'thinking') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'stream' || key === 'chunks' || key === 'dt') continue;
    collectTextBlocks(value, out, depth + 1);
  }
}

function normalizeText(s) {
  return s.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

/**
 * 判断一条记录是否为系统自动注入（时间快照、运行上下文、审批策略等）。
 * 主要依据结构化的 data.source.kind，正则只作兜底。
 */
export function isSystemInjected(r) {
  if (!r) return false;
  if (r.src && INJECTED_KINDS.has(r.src)) return true;
  return SYSTEMIC_ANY.test(r.text) || (SYSTEMIC_SHORT.test(r.text) && r.text.length < 400);
}

/**
 * @returns {{i:number,t:string,ts:number,role:string,text:string,n:number,tool?:string,src?:string,cut?:boolean}|null}
 */
export function extractRecord(ev) {
  const type = ev?.type;
  if (typeof type !== 'string' || !KEEP.has(type)) return null;

  const d = ev.data && typeof ev.data === 'object' ? ev.data : {};
  const parts = [];
  let tool;

  if (type === 'tool/call') {
    tool = typeof d.name === 'string' ? d.name : undefined;
    const args =
      typeof d.arguments === 'string'
        ? d.arguments
        : d.arguments == null
          ? ''
          : JSON.stringify(d.arguments);
    parts.push(`[tool/call ${tool || '?'}] ${args.slice(0, MAX_TOOL_ARGS)}`);
  } else {
    collectTextBlocks(d, parts);
    if (parts.length === 0) {
      const fallback = d.summary ?? d.text ?? d.message ?? d.content;
      if (typeof fallback === 'string') parts.push(fallback);
    }
  }

  let text = normalizeText(parts.join('\n'));
  if (!text) return null;

  let cut = false;
  if (text.length > MAX_RECORD_CHARS) {
    text = text.slice(0, MAX_RECORD_CHARS);
    cut = true;
  }

  const src =
    d.source && typeof d.source === 'object' && typeof d.source.kind === 'string'
      ? d.source.kind
      : undefined;

  const rec = {
    i: Number.isFinite(ev.seq) ? ev.seq : -1,
    t: type,
    ts: Number.isFinite(ev.time) ? ev.time : 0,
    role: ROLE_BY_TYPE[type] || 'other',
    text,
    n: text.length,
  };
  if (tool) rec.tool = tool;
  if (src) rec.src = src;
  if (cut) rec.cut = true;
  return rec;
}

/** 会话标题：优先取第一条真实用户消息，排除系统注入内容。 */
export function deriveTitle(records) {
  for (const r of records) {
    if (r.role !== 'user' || isSystemInjected(r)) continue;
    const oneLine = r.text.replace(/\s+/g, ' ').trim();
    if (!oneLine) continue;
    return oneLine.slice(0, 120);
  }
  const first = records.find((r) => r.text.length > 20 && !isSystemInjected(r));
  return first ? first.text.replace(/\s+/g, ' ').trim().slice(0, 120) : '(无对话内容)';
}

export function isHeader(ev) {
  return ev?.type === 'session';
}
