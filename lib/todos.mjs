/**
 * 未完成事项抽取 —— 回答「我还有什么没做完」。
 *
 * 会话卡里**没有** todos 字段（只有 questions / decisions / paths / files / tools / keywords），
 * 所以要从会话记录里现抽。纯规则，零 LLM。
 *
 * 实测踩过的坑（第一版抽出来 31 条里大半是垃圾）：会话记录里绝大多数是
 * `tool-call` / `tool-result`（工具参数 JSON、命令输出、代码 diff），
 * 里面有大量「还没」「缺少」字样 —— 那不是待办。所以：
 *
 *   1. **只看对话正文**：`role` 必须是 `user` / `assistant`，工具记录整条跳过；
 *   2. **跳过 Markdown 代码块**（``` 围栏内的一切）与整行代码 / 输出 / 表格；
 *   3. 句子必须命中**未完成语气**，且不能被**已完成语气**否决
 *      （「已经修复完毕」不该被当成待办 —— 这是这类启发式最容易犯的错）；
 *   4. 还要有「像任务」的样子：句首标记（TODO/待办/下一步…）**或**含动作动词
 *      （修/补/加/改/跑/验证/清理/迁移/确认…），否则丢弃；
 *   5. 归一化去重（同一件事在多条记录里重复出现只留一条，取最后一次的时间）。
 */
import { isSystemInjected } from './extract.mjs';
import { projectOf } from './workspace.mjs';

/** 未完成的语气（句首标记优先）。 */
const LEADING_HINT = /^(?:[-*\d.、\s]*)(?:TODO|FIXME|WIP|待办|待做|待确认|待验证|待补|待迁移|下一步|接下来|后续|尚未|还没|未完成|未处理|遗留|仍需要|还需要|缺少)/i;

/** 句中出现的未完成信号。 */
const OPEN_HINT = new RegExp(
  [
    '\\bTODO\\b', '\\bFIXME\\b', '\\bWIP\\b', '待办', '待做', '待完成', '待验证', '待确认', '待补',
    '未完成', '没做完', '还没', '尚未', '未处理', '未修复', '遗留', '后续', '下一步', '接下来',
    '还需要', '仍需要', '仍待', '缺少', '待定', '下次再', '稍后',
    '\\bremaining\\b', '\\bfollow[- ]?up\\b', '\\bnot yet\\b', '\\bunfinished\\b', '\\bstill need\\b',
  ].join('|'),
  'i',
);

/** 已完成语气：同一句里出现就**不算**待办。 */
const DONE_HINT = new RegExp(
  [
    '已完成', '已修复', '已解决', '已处理', '已确认', '已上线', '已合并', '已提交', '已通过', '已跑通',
    '搞定了', '做完了', '修好了', '解决了', '\\bdone\\b', '\\bfixed\\b', '\\bresolved\\b', '\\bshipped\\b',
    '\\bcompleted\\b',
  ].join('|'),
  'i',
);

/** 「像任务」的动作词。 */
const ACTION_HINT = /(修|补|加|改|跑|删|查|写|迁移|替换|验证|确认|核对|清理|优化|重构|升级|回滚|上线|合并|提交|部署|测试|补全|调查|排查|处理|拆分|接入|对接|覆盖)/;

/** 明显不是待办的行：代码、输出、表格、引用、纯标点。 */
const NOT_PROSE = /^(?:[{}[\]|>#`*\-+=/\\]|\s*PASS\b|\s*FAIL\b|\s*✓|\s*✗|\s*\[tool)/;

/** 太碎的句子不要。 */
const NOISE = /^(好的?|收到|谢谢|嗯+|ok|okay|明白|了解|继续|没问题|了解)[。！!.~]*$/i;
/** 以「明白，…」这类应答开头、后面接一句已完成叙述的，也不是待办。 */
const ACK_LEAD = /^(好的?|收到|明白|了解|没问题|收到啦|行|可以)[，,、]/;

/** 会话正文里会混进「用户输入包装标记」（如 `</user_query>`）与零宽字符，先清掉。 */
function stripArtifacts(text) {
  return String(text || '')
    .replace(/<\/?[a-zA-Z_][\w:-]*(\s[^>]*)?>/g, ' ') // <user_query> / </user_query> / <br /> 之类
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/&lt;|&gt;|&amp;/g, ' ');
}

const MAX_TEXT = 180;
/** 代码味太重的句子不要（JSON / 转义 / 大量符号）。 */
function looksLikeCode(text) {
  if (/\\n|\\"|=>|;\s*$|\{\s*"/.test(text)) return true;
  const symbols = (text.match(/[{}()[\];:=<>|`$\\]/g) || []).length;
  return symbols / Math.max(1, text.length) > 0.12;
}

/** 按句号/换行/分号切句，保持中文标点。 */
function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[。！？；!?;\n])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
}

function clampText(text) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT)}…` : clean;
}

function dedupeKey(text) {
  return String(text)
    .toLowerCase()
    .replace(/[\s`'"“”‘’（）()【】\[\]<>《》:：,，.。!！?？;；、/\\|-]+/g, '')
    .slice(0, 120);
}

/**
 * 把引号 / 反引号里的内容抹掉再判定。
 *
 * 实测误判：「现在做面板**「待办」页签**」这种**计划陈述**里，「待办」只是被引用的界面名，
 * 整句并不是待办。引号里的东西多半是「名字/标签/代码标识」，不参与语气判定；
 * 正文本身保留原样输出。
 */
function blankQuoted(text) {
  return String(text)
    .replace(/「[^」]*」/g, ' ')
    .replace(/『[^』]*』/g, ' ')
    .replace(/“[^”]*”/g, ' ')
    .replace(/"[^"]*"/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1'); // 粗体保留内容：里面常是重点
}

/** 一段对话正文里是否像「任务句」。 */
function classify(sentence) {
  const bare = blankQuoted(sentence);
  if (NOISE.test(bare)) return null;
  if (ACK_LEAD.test(bare) && !LEADING_HINT.test(bare)) return null;
  if (NOT_PROSE.test(bare)) return null;
  if (looksLikeCode(bare)) return null;
  if (!OPEN_HINT.test(bare)) return null;
  if (DONE_HINT.test(bare)) return null;
  const leading = LEADING_HINT.test(bare);
  const act = ACTION_HINT.test(bare);
  if (!leading && !act) return null;
  return /(TODO|FIXME|WIP|待办|待做)/i.test(bare) ? 'todo' : 'followUp';
}

/**
 * 从一组记录里抽未完成事项。
 * @param {Array<object>} records 会话记录（含 i/role/t/text/ts）
 * @returns {Array<{text: string, seq: number, role: string, time: number, kind: string}>}
 */
export function extractOpenItems(records = []) {
  const out = [];
  for (const record of records) {
    if (!record) continue;
    // 1) 只认对话正文：工具调用/结果的参数与输出里全是「还没」「缺少」这类词，不是待办
    if (record.role !== 'user' && record.role !== 'assistant') continue;
    if (isSystemInjected(record)) continue;
    const text = stripArtifacts(record.text);
    if (!text) continue;

    let inFence = false;
    for (const rawLine of text.split('\n')) {
      // 2) 跳过 Markdown 代码块
      if (/^\s*```/.test(rawLine)) { inFence = !inFence; continue; }
      if (inFence) continue;
      for (const sentence of splitSentences(rawLine)) {
        const kind = classify(sentence);
        if (!kind) continue;
        out.push({
          text: clampText(sentence),
          seq: Number(record.i) || 0,
          role: String(record.role || ''),
          time: Number(record.ts) || 0,
          kind,
        });
      }
    }
  }
  // 3) 同一段话在多条记录里重复出现：留最后一条（最新），seq 取第一次出现的位置
  const seen = new Map();
  for (const item of out) {
    const key = dedupeKey(item.text);
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, item);
      continue;
    }
    seen.set(key, {
      ...prev,
      time: Math.max(prev.time, item.time),
      seq: Math.min(prev.seq || Number.MAX_SAFE_INTEGER, item.seq || Number.MAX_SAFE_INTEGER),
      kind: item.kind === 'todo' ? 'todo' : prev.kind,
    });
  }
  return [...seen.values()].sort((a, b) => b.time - a.time);
}

/**
 * 把一批会话的未完成事项汇总，按项目分组。
 *
 * @param {object} options
 * @param {Array<{card: object, records: Array<object>|null}>} options.sessions 已读好的会话（records 为 null 表示无分片）
 * @param {number} [options.perSession=4] 每个会话最多取几条（防止单个大会话刷屏）
 * @param {number} [options.limit=40] 总计最多返回几条
 */
export function aggregateOpenItems({ sessions = [], perSession = 4, limit = 40 } = {}) {
  const items = [];
  let scanned = 0;
  let skipped = 0;
  let crossSessionDeduped = 0;
  for (const { card, records } of sessions) {
    if (!card) continue;
    if (!Array.isArray(records) || records.length === 0) {
      skipped += 1;
      continue;
    }
    scanned += 1;
    const open = extractOpenItems(records).slice(0, perSession);
    for (const item of open) {
      items.push({
        ...item,
        sessionId: card.id,
        title: String(card.title || ''),
        app: card.app || 'dsh',
        workspace: card.workspace || '',
        project: projectOf(card.workspace) || '(未记录)',
        sessionUpdatedAt: card.updatedAt || 0,
      });
    }
  }

  // **跨会话**再去一次重：同一件事（比如「下一步可选：① …」）在多个会话里复述很常见，
  // 每个会话内部已去过重，这里按归一化文本合并，保留「最近的那个会话 + 最新的时间」。
  const byKey = new Map();
  for (const item of items) {
    const key = dedupeKey(item.text);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, item);
      continue;
    }
    crossSessionDeduped += 1;
    const keepNew = (item.time || 0) > (prev.time || 0)
      || ((item.time || 0) === (prev.time || 0) && (item.sessionUpdatedAt || 0) > (prev.sessionUpdatedAt || 0));
    const keep = keepNew ? item : prev;
    const other = keepNew ? prev : item;
    byKey.set(key, {
      ...keep,
      // 合并两个来源：会话与 seq 取较新的那个，但把「还出现在别的会话」记下来
      alsoInSessions: [
        ...(prev.alsoInSessions || []),
        ...(item.alsoInSessions || []),
        other.sessionId,
      ].filter((id, i, arr) => id && id !== keep.sessionId && arr.indexOf(id) === i).slice(0, 4),
    });
  }
  const deduped = [...byKey.values()];
  deduped.sort((a, b) => (b.time || 0) - (a.time || 0) || (b.sessionUpdatedAt || 0) - (a.sessionUpdatedAt || 0));
  const kept = deduped.slice(0, limit);

  const groups = new Map();
  for (const item of kept) {
    const key = `${item.app}|${item.project.toLowerCase()}`;
    let slot = groups.get(key);
    if (!slot) {
      slot = { app: item.app, project: item.project, count: 0, items: [] };
      groups.set(key, slot);
    }
    slot.count += 1;
    slot.items.push(item);
  }

  return {
    scanned,
    skipped,
    total: deduped.length,
    rawTotal: items.length,
    crossSessionDeduped,
    returned: kept.length,
    truncated: deduped.length > kept.length,
    items: kept,
    byProject: [...groups.values()].sort((a, b) => b.count - a.count),
  };
}
