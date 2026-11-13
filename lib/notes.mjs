/**
 * 可写入的跨会话长期记忆库。
 *
 * 与「会话卡」的区别：会话卡是历史的只读派生摘要；这里的记忆是用户/Agent 主动写入的
 * 决策、偏好、坑、待办，带类型/标签/重要度，可在新会话里被 brief 自动召回。
 *
 * 落盘：~/.dsh/session-index/notes.json，写前备份、原子写入，不修改任何原始会话。
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadDoc, saveDoc } from './index-store.mjs';
import { tokenize } from './cards.mjs';

const FILE = 'notes.json';
export const NOTE_TYPES = ['decision', 'fact', 'preference', 'todo', 'pitfall', 'note'];

const empty = () => ({ version: 1, updatedAt: null, notes: [] });

export function loadNotes(indexDir) {
  const doc = loadDoc(indexDir, FILE, empty);
  if (!Array.isArray(doc.notes)) doc.notes = [];
  return doc;
}

export function saveNotes(indexDir, doc) {
  doc.version = 1;
  doc.updatedAt = new Date().toISOString();
  saveDoc(indexDir, FILE, doc, { backup: true, backupPrefix: 'notes.json.bak-' });
}

const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

function newId() {
  return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 新增或合并一条记忆。相同文本+类型未归档时视为同一条，更新重要度/标签而不是重复写入。
 * @returns {{note:object, created:boolean, merged:boolean}}
 */
export function addNote(doc, input = {}) {
  const text = String(input.text || '').trim();
  if (!text) throw new Error('记忆内容 text 不能为空');
  if (text.length > 4000) throw new Error('单条记忆最多 4000 字');
  const type = NOTE_TYPES.includes(input.type) ? input.type : 'note';
  const key = `${type}:${normText(text)}`;
  const tags = Array.isArray(input.tags)
    ? input.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8)
    : [];
  const importance = Math.min(5, Math.max(1, Number(input.importance) || 3));
  const existing = doc.notes.find((n) => !n.archived && `${n.type}:${normText(n.text)}` === key);
  if (existing) {
    existing.importance = Math.max(existing.importance || 3, importance);
    existing.tags = [...new Set([...(existing.tags || []), ...tags])].slice(0, 8);
    if (input.sessionId) existing.sessionId = input.sessionId;
    existing.updatedAt = Date.now();
    return { note: existing, created: false, merged: true };
  }
  const note = {
    id: newId(),
    text,
    type,
    tags,
    importance,
    app: input.app || 'manual',
    sessionId: input.sessionId || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hits: 0,
    archived: false,
  };
  doc.notes.push(note);
  return { note, created: true, merged: false };
}

/** 召回记忆：关键词相关度 + 重要度 + 时间新鲜度，归档项默认排除。 */
export function queryNotes(doc, opts = {}) {
  const q = String(opts.query || '').trim();
  const terms = q ? tokenize(q) : [];
  const ql = q.toLowerCase();
  const type = opts.type ? String(opts.type) : '';
  const tags = Array.isArray(opts.tags) ? opts.tags.map(String) : [];
  const now = Date.now();
  const day = 86400000;

  const rows = doc.notes
    .filter((n) => (opts.includeArchived ? true : !n.archived))
    .filter((n) => !type || n.type === type)
    .filter((n) => tags.length === 0 || tags.every((t) => (n.tags || []).includes(t)))
    .map((n) => {
      const lower = `${n.text} ${(n.tags || []).join(' ')}`.toLowerCase();
      let score = 0;
      if (ql && lower.includes(ql)) score += 6;
      for (const t of terms) if (lower.includes(t)) score += 2;
      score += (n.importance || 3) * 0.8;
      const ageDays = Math.max(0, (now - (n.updatedAt || n.createdAt || now)) / day);
      score += Math.max(0, 3 - ageDays / 14); // 两周内较新加分，随时间衰减
      return { note: n, score, matched: terms.filter((t) => lower.includes(t)).slice(0, 6) };
    })
    .filter((r) => !q || r.score > 3)
    .sort((a, b) => b.score - a.score || b.note.updatedAt - a.note.updatedAt);

  const limit = Math.min(50, Math.max(1, Number(opts.limit) || 10));
  return rows.slice(0, limit);
}

/** 默认归档（不物理删除）；purge=true 才移除。 */
export function removeNote(doc, id, purge = false) {
  const idx = doc.notes.findIndex((n) => n.id === id || n.id.startsWith(String(id)));
  if (idx === -1) throw new Error(`未找到记忆 ${id}`);
  const note = doc.notes[idx];
  if (purge) {
    doc.notes.splice(idx, 1);
    return { id: note.id, purged: true };
  }
  note.archived = true;
  note.updatedAt = Date.now();
  return { id: note.id, archived: true };
}

/** 供向量层使用：把未归档记忆转成可嵌入的文本块。 */
export function noteChunks(doc) {
  return doc.notes
    .filter((n) => !n.archived)
    .map((n) => ({
      id: `note:${n.id}`,
      sessionId: n.sessionId || null,
      app: n.app || 'manual',
      kind: 'memory',
      text: `[${n.type}] ${n.text} ${(n.tags || []).join(' ')}`.slice(0, 1200),
    }));
}

export function notesStats(doc) {
  const active = doc.notes.filter((n) => !n.archived);
  const byType = {};
  for (const n of active) byType[n.type] = (byType[n.type] || 0) + 1;
  return {
    total: doc.notes.length,
    active: active.length,
    archived: doc.notes.length - active.length,
    byType,
    updatedAt: doc.updatedAt,
    file: path.join(FILE),
  };
}

export function notesFileSize(indexDir) {
  const p = path.join(indexDir, FILE);
  return fs.existsSync(p) ? fs.statSync(p).size : 0;
}
