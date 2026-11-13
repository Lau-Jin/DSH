/**
 * 索引存储层：meta.json（会话元数据）+ 每会话一个 .jsonl.gz（记录全文）
 * + cards.json（跨会话会话卡）。
 *
 * 设计要点：
 * - list / status 只读 meta.json（几十 KB），永远不解压会话源文件；
 * - search / get 只解压命中的那个会话索引文件，不碰其它会话；
 * - brief / related / thread 只读 cards.json，不碰记录全文；
 * - 索引文件全部是派生数据，源会话文件永不修改。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const META_FILE = 'meta.json';
const CARDS_FILE = 'cards.json';

export function emptyMeta(sourceRoot, indexDir) {
  return { version: 1, builtAt: null, sourceRoot, indexDir, sessions: {} };
}

function emptyCards() {
  return { version: 1, builtAt: null, cards: {} };
}

export function loadMeta(indexDir, sourceRoot) {
  const p = path.join(indexDir, META_FILE);
  if (!fs.existsSync(p)) return emptyMeta(sourceRoot, indexDir);
  try {
    const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!meta || typeof meta.sessions !== 'object' || meta.sessions === null) {
      return emptyMeta(sourceRoot, indexDir);
    }
    meta.sourceRoot = sourceRoot;
    meta.indexDir = indexDir;
    return meta;
  } catch {
    return emptyMeta(sourceRoot, indexDir);
  }
}

export function loadCards(indexDir) {
  const p = path.join(indexDir, CARDS_FILE);
  if (!fs.existsSync(p)) return emptyCards();
  try {
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!doc || typeof doc.cards !== 'object' || doc.cards === null) return emptyCards();
    return doc;
  } catch {
    return emptyCards();
  }
}

function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

export function saveMeta(indexDir, meta) {
  fs.mkdirSync(indexDir, { recursive: true });
  atomicWrite(path.join(indexDir, META_FILE), JSON.stringify(meta, null, 2));
}

export function saveCards(indexDir, doc) {
  fs.mkdirSync(indexDir, { recursive: true });
  atomicWrite(path.join(indexDir, CARDS_FILE), JSON.stringify(doc));
}

export function saveRecords(indexDir, sessionId, records) {
  fs.mkdirSync(indexDir, { recursive: true });
  const body = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
  const gz = zlib.gzipSync(Buffer.from(body, 'utf8'), { level: 6 });
  const file = `${safeName(sessionId)}.jsonl.gz`;
  atomicWrite(path.join(indexDir, file), gz);
  return { file, bytes: gz.length };
}

/** 返回某个会话的全部记录（仅该会话，按需调用）。 */
export function readRecords(indexDir, sessionMeta) {
  const p = path.join(indexDir, sessionMeta.file);
  if (!fs.existsSync(p)) return [];
  const text = zlib.gunzipSync(fs.readFileSync(p)).toString('utf8');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 跳过坏行
    }
  }
  return out;
}

function safeName(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * 通用 JSON 文档读写（notes.json / vectors.json 等）。
 * backup=true 时写前留一份带时间戳的备份，只写目标文件，绝不触碰其它文件。
 */
export function loadDoc(indexDir, file, emptyFactory) {
  const p = path.join(indexDir, file);
  if (!fs.existsSync(p)) return emptyFactory();
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return emptyFactory();
  }
}

export function saveDoc(indexDir, file, doc, { backup = false, backupPrefix = '' } = {}) {
  fs.mkdirSync(indexDir, { recursive: true });
  const target = path.join(indexDir, file);
  if (backup && fs.existsSync(target)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      fs.copyFileSync(target, `${target}.bak-${stamp}`);
    } catch {
      // 备份失败不阻断主写入
    }
  }
  atomicWrite(target, JSON.stringify(doc));
  if (backupPrefix) void backupPrefix;
}

export function signatureOf(stat) {
  return `${stat.size}:${Math.round(stat.mtimeMs)}`;
}

export function indexSizeBytes(indexDir) {
  if (!fs.existsSync(indexDir)) return 0;
  let total = 0;
  for (const name of fs.readdirSync(indexDir)) {
    try {
      total += fs.statSync(path.join(indexDir, name)).size;
    } catch {
      // ignore
    }
  }
  return total;
}
