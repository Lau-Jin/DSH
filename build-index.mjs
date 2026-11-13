/**
 * 多源全会话增量索引构建器（DSH + WorkBuddy + 跨会话会话卡）。
 *
 * 用法：
 *   node build-index.mjs                    # 增量：只重建 size/mtime 变化的会话
 *   node build-index.mjs --force            # 全量重建
 *   node build-index.mjs --apps dsh         # 只索引 DSH（也可 workbuddy / dsh,workbuddy）
 *   node build-index.mjs --quiet 45000      # 跳过最近 45 秒内仍在写入的活跃会话
 *   node build-index.mjs --json             # JSON 输出统计（供自动守护进程解析）
 *
 * 环境变量：
 *   DSH_HOME                 DSH 主目录，默认 ~/.dsh
 *   SESSION_INDEX_DIR        索引输出目录，默认 $DSH_HOME/session-index
 *   WORKBUDDY_HOME           WorkBuddy 主目录，默认 ~/.workbuddy
 *   WORKBUDDY_PROJECTS_DIR   WorkBuddy 会话目录，默认 $WORKBUDDY_HOME/projects
 *   SESSION_INDEX_APPS       要索引的源，默认 dsh,workbuddy
 *
 * 要求 Node >= 22.15（zlib.zstdDecompressSync）。所有源会话文件只读，绝不修改。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readSessionEvents, assertZstdSupport } from './lib/reader.mjs';
import { extractRecord, deriveTitle, isHeader } from './lib/extract.mjs';
import { buildCard } from './lib/cards.mjs';
import { workbuddyPaths, findWorkbuddySessions, readWorkbuddySession } from './lib/source-workbuddy.mjs';
import {
  loadMeta,
  saveMeta,
  loadCards,
  saveCards,
  saveRecords,
  readRecords,
  signatureOf,
  indexSizeBytes,
} from './lib/index-store.mjs';

export function defaultPaths(env = process.env) {
  const dshHome = env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const wb = workbuddyPaths(env);
  return {
    dshHome,
    sessionsRoot: env.DSH_SESSIONS_DIR || path.join(dshHome, 'sessions'),
    indexDir: env.SESSION_INDEX_DIR || path.join(dshHome, 'session-index'),
    workbuddyProjectsDir: wb.projectsDir,
  };
}

function findDshSessions(root, maxDepth = 3) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
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
  return out.sort();
}

/** DSH 源：分帧 zstd → 统一 header/records。 */
function readDshSession(file, onWarning) {
  let headerEv = null;
  const records = [];
  let eventCount = 0;
  for (const ev of readSessionEvents(file, { onWarning })) {
    eventCount += 1;
    if (isHeader(ev)) headerEv = ev;
    const rec = extractRecord(ev);
    if (rec) records.push(rec);
  }
  const sourceId =
    (headerEv && typeof headerEv.id === 'string' && headerEv.id) || path.basename(path.dirname(file));
  return {
    header: {
      id: sourceId,
      sourceId,
      app: 'dsh',
      cwd: (headerEv && typeof headerEv.cwd === 'string' && headerEv.cwd) || path.basename(path.dirname(path.dirname(file))),
      title: deriveTitle(records),
      createdAt: Number.isFinite(headerEv?.createdAt) ? headerEv.createdAt : 0,
      updatedAt: records.length ? records[records.length - 1].ts : 0,
      parentSession: headerEv?.parentSession || null,
    },
    records,
    eventCount,
    warnings: [],
  };
}

function parseArgs(argv) {
  const opts = { force: false, json: false, sessions: null, index: null, apps: null, quietMs: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--sessions' && argv[i + 1]) opts.sessions = argv[++i];
    else if (a === '--index' && argv[i + 1]) opts.index = argv[++i];
    else if (a === '--apps' && argv[i + 1]) opts.apps = argv[++i];
    else if (a === '--quiet' && argv[i + 1]) opts.quietMs = Number(argv[++i]) || 0;
  }
  return opts;
}

/**
 * 构建（或增量刷新）多源索引 + 会话卡。
 * @param {object} options quietMs>0 时跳过最近仍在写入的活跃会话，避免自动刷新反复解压
 */
export function buildIndex(options = {}) {
  assertZstdSupport();
  const defaults = defaultPaths();
  const sessionsRoot = options.sessionsRoot || defaults.sessionsRoot;
  const indexDir = options.indexDir || defaults.indexDir;
  const workbuddyProjectsDir = options.workbuddyProjectsDir || defaults.workbuddyProjectsDir;
  const apps = String(options.apps || process.env.SESSION_INDEX_APPS || 'dsh,workbuddy')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const force = Boolean(options.force);
  const quietMs = Math.max(0, Number(options.quietMs) || 0);
  const warnings = [];
  const started = Date.now();

  if (!fs.existsSync(sessionsRoot) && apps.includes('dsh')) {
    throw new Error(`DSH 会话目录不存在: ${sessionsRoot}`);
  }
  fs.mkdirSync(indexDir, { recursive: true });

  const sources = [];
  if (apps.includes('dsh')) sources.push({ app: 'dsh', files: findDshSessions(sessionsRoot) });
  if (apps.includes('workbuddy')) {
    sources.push({ app: 'workbuddy', files: findWorkbuddySessions(workbuddyProjectsDir) });
  }

  const meta = loadMeta(indexDir, sessionsRoot);
  const cardsDoc = loadCards(indexDir);
  const seen = new Set();
  const stats = {
    apps,
    byApp: {},
    sessionsFound: sources.reduce((n, s) => n + s.files.length, 0),
    rebuilt: 0,
    skipped: 0,
    deferred: 0,
    records: 0,
    events: 0,
    cardsBuilt: 0,
    warnings,
  };

  for (const src of sources) {
    for (const file of src.files) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        warnings.push(`无法读取 stat: ${file}`);
        continue;
      }
      const sig = signatureOf(stat);
      const candidateId =
        src.app === 'dsh' ? path.basename(path.dirname(file)) : `wb:${path.basename(file, '.jsonl')}`;
      const cached = meta.sessions[candidateId];
      const cachedFile = cached && path.join(indexDir, cached.file);

      // 静止期只用于「已有索引且正在写入」的会话，避免反复解压同一文件。
      // 全新会话必须立即纳入：它写完后不会再有文件事件，若被跳过就永远进不了索引。
      if (!force && quietMs > 0 && cached && Date.now() - stat.mtimeMs < quietMs) {
        seen.add(candidateId);
        stats.deferred += 1;
        stats.records += cached.records || 0;
        continue;
      }

      if (
        !force &&
        cached &&
        cached.signature === sig &&
        cached.sourcePath === file &&
        cachedFile &&
        fs.existsSync(cachedFile)
      ) {
        seen.add(candidateId);
        stats.skipped += 1;
        stats.records += cached.records || 0;
        if (!cardsDoc.cards[candidateId]) {
          try {
            cardsDoc.cards[candidateId] = buildCard(cached, readRecords(indexDir, cached));
            stats.cardsBuilt += 1;
          } catch (err) {
            warnings.push(`会话卡补建失败 ${candidateId}: ${err.message}`);
          }
        }
        continue;
      }

      let parsed;
      try {
        parsed =
          src.app === 'dsh'
            ? readDshSession(file, (m) => warnings.push(m))
            : readWorkbuddySession(file);
      } catch (err) {
        warnings.push(`解析失败，已跳过 ${file}: ${err.message}`);
        continue;
      }
      for (const w of parsed.warnings || []) warnings.push(w);

      const sessionId = parsed.header.id || candidateId;
      const saved = saveRecords(indexDir, sessionId, parsed.records);
      const sessionMeta = {
        id: sessionId,
        app: src.app,
        sourceId: parsed.header.sourceId || sessionId,
        workspace: parsed.header.cwd,
        cwd: parsed.header.cwd,
        title: parsed.header.title || deriveTitle(parsed.records),
        createdAt: Math.round(parsed.header.createdAt || stat.birthtimeMs),
        updatedAt: Math.round(parsed.header.updatedAt || stat.mtimeMs),
        parentSession: parsed.header.parentSession || null,
        sourcePath: file,
        signature: sig,
        sourceBytes: stat.size,
        events: parsed.eventCount,
        records: parsed.records.length,
        indexBytes: saved.bytes,
        file: saved.file,
      };
      meta.sessions[sessionId] = sessionMeta;
      try {
        cardsDoc.cards[sessionId] = buildCard(sessionMeta, parsed.records);
        stats.cardsBuilt += 1;
      } catch (err) {
        warnings.push(`会话卡生成失败 ${sessionId}: ${err.message}`);
      }

      seen.add(sessionId);
      if (sessionId !== candidateId && meta.sessions[candidateId]) {
        delete meta.sessions[candidateId];
        delete cardsDoc.cards[candidateId];
      }
      stats.rebuilt += 1;
      stats.events += parsed.eventCount;
      stats.records += parsed.records.length;
    }
  }

  const orphans = Object.keys(meta.sessions).filter((id) => !seen.has(id));
  for (const id of orphans) {
    delete meta.sessions[id]; // 只从目录移除，不删除任何磁盘文件
    delete cardsDoc.cards[id];
  }
  for (const s of Object.values(meta.sessions)) {
    const app = s.app || 'dsh';
    stats.byApp[app] = (stats.byApp[app] || 0) + 1;
  }

  meta.builtAt = new Date().toISOString();
  meta.sourceRoot = sessionsRoot;
  meta.indexDir = indexDir;
  meta.apps = apps;
  saveMeta(indexDir, meta);

  cardsDoc.version = 1;
  cardsDoc.builtAt = meta.builtAt;
  saveCards(indexDir, cardsDoc);

  stats.orphansRemovedFromMeta = orphans.length;
  stats.sessionsIndexed = Object.keys(meta.sessions).length;
  stats.cardsIndexed = Object.keys(cardsDoc.cards).length;
  stats.indexBytes = indexSizeBytes(indexDir);
  stats.elapsedMs = Date.now() - started;
  stats.indexDir = indexDir;
  stats.sourceRoot = sessionsRoot;
  stats.workbuddyProjectsDir = workbuddyProjectsDir;
  return stats;
}

const isCli =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    const result = buildIndex({
      sessionsRoot: opts.sessions,
      indexDir: opts.index,
      apps: opts.apps,
      force: opts.force,
      quietMs: opts.quietMs,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';
      console.log(
        `索引完成：会话 ${result.sessionsIndexed} 个 ${JSON.stringify(result.byApp)}` +
          `（重建 ${result.rebuilt} / 跳过 ${result.skipped} / 延迟活跃 ${result.deferred}），记录 ${result.records} 条，` +
          `会话卡 ${result.cardsIndexed} 张（新建 ${result.cardsBuilt}），` +
          `索引体积 ${mb(result.indexBytes)}，耗时 ${result.elapsedMs} ms`
      );
      if (result.warnings.length) console.log(`警告 ${result.warnings.length} 条：`, result.warnings.slice(0, 3));
      console.log(`索引目录：${result.indexDir}`);
    }
  } catch (err) {
    console.error('索引构建失败：' + err.message);
    process.exitCode = 1;
  }
}
