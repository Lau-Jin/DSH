/**
 * WorkBuddy 会话源适配器。
 *
 * 本机实测位置：~/.workbuddy/projects/<workspace>/<sessionId>.jsonl
 * 每行一个 JSON 事件，主要类型：
 *   message(user/assistant)  content:[{type:input_text|output_text|text,text}]
 *   function_call            name + arguments(JSON 字符串)
 *   function_call_result     name + output:{type,text}
 *   reasoning                思考，跳过
 *   ai-title                 aiTitle，直接用作会话标题
 *   session-meta / file-history-snapshot / queue-operation 等   跳过
 *
 * 用户消息里含 <system-reminder>...</system-reminder> 注入块，必须剥除，
 * 否则会把系统上下文当成用户提问，污染标题与检索。
 *
 * 输出统一成与 DSH 相同的记录结构，交由同一个索引/卡片/检索层处理。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { deriveTitle } from './extract.mjs';

const MAX_RECORD_CHARS = 30000;

export function workbuddyPaths(env = process.env) {
  const home = env.WORKBUDDY_HOME || path.join(os.homedir(), '.workbuddy');
  return {
    home,
    projectsDir: env.WORKBUDDY_PROJECTS_DIR || path.join(home, 'projects'),
  };
}

export function findWorkbuddySessions(projectsDir) {
  const out = [];
  if (!fs.existsSync(projectsDir)) return out;
  const walk = (dir, depth) => {
    if (depth > 2) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(projectsDir, 0);
  return out.sort();
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) =>
      b && (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text')
        ? String(b.text || '')
        : ''
    )
    .filter(Boolean)
    .join('\n');
}

function stripInjected(text) {
  let s = String(text || '');
  s = s.replace(/<system-reminder\b[\s\S]*?<\/system-reminder>/gi, '');
  s = s.replace(/<system-reminder\b[^>]*\/?>/gi, '');
  s = s.replace(/<user_info>[\s\S]*?<\/user_info>/gi, '');
  return s.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

function makeRecord(ev, i, role, type, rawText, tool) {
  let text = stripInjected(rawText);
  if (!text) return null;
  const cut = text.length > MAX_RECORD_CHARS;
  if (cut) text = text.slice(0, MAX_RECORD_CHARS);
  const rec = {
    i,
    t: type,
    ts: Number.isFinite(ev.timestamp) ? ev.timestamp : 0,
    role,
    text,
    n: text.length,
  };
  if (tool) rec.tool = tool;
  if (cut) rec.cut = true;
  return rec;
}

/**
 * 读取一个 WorkBuddy 会话文件。
 * @returns {{header:object, records:object[], eventCount:number, warnings:string[]}}
 */
export function readWorkbuddySession(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  const records = [];
  const warnings = [];
  let eventCount = 0;
  let title = '';
  let cwd = '';
  let firstTs = 0;
  let lastTs = 0;
  let seq = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    eventCount += 1;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (Number.isFinite(ev.timestamp)) {
      if (!firstTs || ev.timestamp < firstTs) firstTs = ev.timestamp;
      if (ev.timestamp > lastTs) lastTs = ev.timestamp;
    }
    if (!cwd && typeof ev.cwd === 'string') cwd = ev.cwd;
    if (ev.type === 'ai-title' && typeof ev.aiTitle === 'string' && ev.aiTitle.trim()) {
      title = ev.aiTitle.trim();
      continue;
    }

    let rec = null;
    if (ev.type === 'message' && ev.role === 'user') {
      // 只剥除 <system-reminder> 注入块，保留同一条消息里用户的真实提问；
      // 剥完为空的自然被 makeRecord 丢弃，不把整条标成系统噪声。
      rec = makeRecord(ev, seq, 'user', 'user/message', stripInjected(blockText(ev.content)));
    } else if (ev.type === 'message' && ev.role === 'assistant') {
      rec = makeRecord(ev, seq, 'assistant', 'assistant/message', blockText(ev.content));
    } else if (ev.type === 'function_call') {
      const name = typeof ev.name === 'string' ? ev.name : '?';
      const args = typeof ev.arguments === 'string' ? ev.arguments : JSON.stringify(ev.arguments || '');
      rec = makeRecord(ev, seq, 'tool-call', 'tool/call', `[tool/call ${name}] ${args.slice(0, 8000)}`, name);
    } else if (ev.type === 'function_call_result') {
      const out = typeof ev.output === 'string' ? ev.output : ev.output?.text || '';
      rec = makeRecord(ev, seq, 'tool-result', 'tool/result', out);
      if (rec && typeof ev.name === 'string') rec.tool = ev.name;
    }
    if (rec) {
      records.push(rec);
      seq += 1;
    }
  }

  const sourceId = path.basename(filePath, '.jsonl');
  const header = {
    id: `wb:${sourceId}`,
    sourceId,
    app: 'workbuddy',
    cwd: cwd || path.basename(path.dirname(filePath)),
    title: title || deriveTitle(records),
    createdAt: firstTs,
    updatedAt: lastTs,
    parentSession: null,
  };
  return { header, records, eventCount, warnings };
}
