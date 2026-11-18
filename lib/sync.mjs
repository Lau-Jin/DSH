/**
 * 跨终端同步 —— 把「会话卡 + 长期记忆」推到一个**私有 git 仓**，
 * 另一台终端装上插件后拉取合并，于是那台机器也能搜到这边的历史结论。
 *
 * 三个设计取舍（写在这里，免得以后忘了为什么）：
 *
 *  1. **只同步 cards.json + notes.json，不同步记录分片**。
 *     记录分片（`*.jsonl.gz`）是会话原文，几十 MB 且含隐私；它们是派生数据，
 *     源会话在那台机器上本来就有（或本来就没有）。只搬会话卡与记忆，
 *     另一终端就能 `brief / search / related / card` + 记忆召回；
 *     `get` 拿不到原文 —— 这是取舍，不是缺陷。
 *
 *  2. **合并，绝不覆盖**。两台机器都会继续产生新会话，谁覆盖谁都会丢数据。
 *     同 id 取 `updatedAt` 更大的那份；记忆再按「类型 + 归一化文本」去重一次
 *     （两台机器各自 remember 同一句话时不会变成两条）。
 *     push 与 pull 是**同一个 union 合并**，区别只是最后要不要把结果推上去。
 *
 *  3. **git 工作副本放在索引目录里**（`<indexDir>/sync-remote`），不进插件包、
 *     不进 `dist/`，重装插件不丢；远端地址写在 `<indexDir>/sync.json`，同理。
 *
 * 真相在 `indexDir`，不在工作副本：工作副本每次同步都会对齐远端再写入，
 * 所以它丢了、脏了都无所谓（`git checkout -B <branch> FETCH_HEAD`）。
 *
 * 安全：远端必须是**私有仓**（会话卡里有结论与路径）。git 一律
 * `GIT_TERMINAL_PROMPT=0` + `BatchMode=yes`，任何需要交互的场景都直接失败
 * 并给出人话错误，**绝不挂起 MCP 进程**。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCards, saveCards } from './index-store.mjs';
import { loadNotes, saveNotes } from './notes.mjs';
import { createZip } from './pack.mjs';

/** 配置文件名（相对索引目录）。 */
export const CONFIG_FILE = 'sync.json';
/** git 工作副本目录名（相对索引目录）。 */
export const REMOTE_DIR = 'sync-remote';
/** 远端仓里放的文件。 */
export const REMOTE_FILES = ['cards.json', 'notes.json', 'manifest.json'];

export class SyncError extends Error {
  constructor(message, hint = '') {
    super(message);
    this.name = 'SyncError';
    this.hint = hint;
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

function resolveIndexDir() {
  return process.env.SESSION_INDEX_DIR
    || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'session-index');
}

function pluginVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version;
  } catch {
    return '';
  }
}

function configPath(indexDir) {
  return path.join(indexDir, CONFIG_FILE);
}

/** 读同步配置；没有就是一份空配置（未配置状态）。 */
export function loadSyncConfig(indexDir = resolveIndexDir()) {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(indexDir), 'utf8'));
    return {
      repo: String(raw.repo || ''),
      branch: String(raw.branch || 'main'),
      lastPushAt: raw.lastPushAt || null,
      lastPullAt: raw.lastPullAt || null,
      machine: String(raw.machine || os.hostname()),
      plugin: String(raw.plugin || ''),
    };
  } catch {
    return {
      repo: '', branch: 'main', lastPushAt: null, lastPullAt: null,
      machine: os.hostname(), plugin: '',
    };
  }
}

/** 包根目录（lib/ 的上一级）——默认远端文件放在这里。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 解析「要跟哪个远端同步」，三处来源，优先级从高到低：
 *   1. 环境变量 `SESSION_INDEX_SYNC_REPO`（部署时用，最灵活）
 *   2. 本机 `sync.json`（面板里保存过的）
 *   3. 包内 `sync.default.json`（**随包分发**，装上就知道该跟哪个仓同步）
 *
 * 第 3 条是为了「另一台终端装上就能直接拉」：不用每台机器手填一次地址。
 * 不想把地址写进公开包的话，删掉包里的 `sync.default.json` 即可（会退回手填）。
 *
 * @returns {{repo: string, branch: string, source: 'env'|'local'|'package'|'none'}}
 */
export function resolveRepo(indexDir = resolveIndexDir()) {
  const envRepo = String(process.env.SESSION_INDEX_SYNC_REPO || '').trim();
  if (envRepo) {
    return {
      repo: envRepo,
      branch: String(process.env.SESSION_INDEX_SYNC_BRANCH || 'main'),
      source: 'env',
    };
  }
  const local = loadSyncConfig(indexDir);
  if (local.repo) return { repo: local.repo, branch: local.branch, source: 'local' };
  // 明确表示「这台机器不用包内默认」时（环境变量置 1），退回手填
  if (process.env.SESSION_INDEX_SYNC_NO_DEFAULT === '1') {
    return { repo: '', branch: local.branch || 'main', source: 'none' };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'sync.default.json'), 'utf8'));
    if (raw && raw.repo) {
      return { repo: String(raw.repo), branch: String(raw.branch || 'main'), source: 'package' };
    }
  } catch {
    /* 包里没有默认远端 → 手填 */
  }
  return { repo: '', branch: local.branch || 'main', source: 'none' };
}

/** 写同步配置（合并到已有配置上）。 */
export function saveSyncConfig(patch, indexDir = resolveIndexDir()) {
  const next = { ...loadSyncConfig(indexDir), ...patch };
  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(configPath(indexDir), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function sshCommand() {
  return process.env.SESSION_INDEX_SYNC_SSH
    || 'ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new';
}

/**
 * 跑一条 git 命令。
 * 绝不交互：`GIT_TERMINAL_PROMPT=0` 挡住 HTTPS 凭据弹窗，`BatchMode=yes` 挡住 SSH 询问。
 */
function git(args, { cwd, timeout = 60000 } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = sshCommand();
  try {
    return execFileSync('git', args, {
      cwd, env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = [err.stdout, err.stderr, err.message]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 400);
    throw new SyncError(`git ${args[0]} 失败：${detail || '未知错误'}`, hintFor(args[0], detail));
  }
}

function hintFor(op, detail) {
  if (/could not read Username|Authentication failed|Permission denied|Host key verification failed/i.test(detail)) {
    return 'git 认证失败：确认这台机器的 SSH key 已加到 GitHub 账号，或改用带凭据的 HTTPS 地址。';
  }
  if (/Repository not found/i.test(detail)) {
    return '远端仓不存在或你没有权限（数据仓必须是 Private，且已创建）。';
  }
  if (/Could not resolve host|unable to access|Failed to connect/i.test(detail)) {
    return '网络不通或被代理拦了，稍后重试。';
  }
  if (op === 'clone') return '克隆失败：检查仓库地址与网络。';
  return '';
}

/** git 是否可用（另一终端可能没装）。 */
export function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function remoteDir(indexDir) {
  return path.join(indexDir, REMOTE_DIR);
}

/** 远端仓里的数据（工作副本当前状态）。 */
function readRemote(dir) {
  const read = (name) => {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };
  return { cards: read('cards.json'), notes: read('notes.json'), manifest: read('manifest.json') };
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
}

function manifestOf({ cards, notes, plugin }) {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    machine: os.hostname(),
    plugin: String(plugin || pluginVersion()),
    cards: Object.keys((cards && cards.cards) || {}).length,
    notes: Array.isArray(notes && notes.notes) ? notes.notes.length : 0,
  };
}

/**
 * 克隆（缺就克隆）并**把工作副本对齐到远端分支**。
 * 真相在 indexDir，所以对齐时丢掉工作副本里的本地提交是安全的。
 */
function ensureClone(indexDir, cfg) {
  const dir = remoteDir(indexDir);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    try {
      git(['clone', '--depth', '50', cfg.repo, dir], { timeout: 180000 });
    } catch (err) {
      // 空仓（还没推过任何提交）克隆会成功；这里兜的是地址/权限问题
      if (!/Repository not found|does not appear to be a git repository|could not read Username/i.test(String(err.message))) {
        // 继续尝试本地 init，让首次 push 也能走通（远端是空仓时 clone 其实会成功）
        throw err;
      }
      fs.mkdirSync(dir, { recursive: true });
      git(['init', '-b', cfg.branch], { cwd: dir });
      git(['remote', 'add', 'origin', cfg.repo], { cwd: dir });
    }
  } else {
    let current = '';
    try {
      current = git(['remote', 'get-url', 'origin'], { cwd: dir }).trim();
    } catch {
      current = '';
    }
    if (current !== cfg.repo) git(['remote', 'set-url', 'origin', cfg.repo], { cwd: dir });
  }

  try {
    // 上次同步中断可能留下脏工作区；真相在 indexDir，直接丢弃。
    try {
      git(['reset', '--hard'], { cwd: dir });
    } catch {
      /* 空仓还没有 HEAD，忽略 */
    }
    git(['fetch', 'origin', cfg.branch], { cwd: dir, timeout: 120000 });
    git(['checkout', '-B', cfg.branch, 'FETCH_HEAD'], { cwd: dir });
  } catch (err) {
    // 远端还没有这个分支（首次 push 之前）是正常状态
    if (!/couldn't find remote ref|no such ref|didn't match any|unknown revision/i.test(String(err.message))) throw err;
    try {
      git(['checkout', '-B', cfg.branch], { cwd: dir });
    } catch {
      /* 空仓还没有任何提交，工作副本保持现状即可 */
    }
  }
  return dir;
}

/* ---------------------------------------------------------------- 合并
 * 两台机器都会继续写，谁覆盖谁都会丢数据 → 一律 union。
 */

/** 合并两份 cards 文档；同 id 取 updatedAt 更大的。 */
export function mergeCards(localDoc, remoteDoc) {
  const out = {
    version: 1,
    builtAt: localDoc?.builtAt || remoteDoc?.builtAt || null,
    cards: { ...(localDoc?.cards || {}) },
  };
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const [id, card] of Object.entries(remoteDoc?.cards || {})) {
    const mine = out.cards[id];
    if (!mine) {
      out.cards[id] = card;
      added += 1;
    } else if ((card?.updatedAt || 0) > (mine.updatedAt || 0)) {
      out.cards[id] = card;
      updated += 1;
    } else {
      unchanged += 1;
    }
  }
  const stamps = [localDoc?.builtAt, remoteDoc?.builtAt]
    .map((t) => (t ? Date.parse(t) : NaN))
    .filter((n) => Number.isFinite(n));
  if (stamps.length) out.builtAt = new Date(Math.max(...stamps)).toISOString();
  return { doc: out, added, updated, unchanged, total: Object.keys(out.cards).length };
}

/**
 * 合并两份记忆。
 *
 * 两遍走：
 *   1. **同 id** 先合并（同一台机器改过的那条）；
 *   2. 再按「类型 + 归一化文本」合并不同 id 的同一条
 *      （两台机器各自 `remember` 了同一句话时，不会变成两条）。
 *
 * 合并时标签取并集、重要度取最大、正文取 `updatedAt` 更新的那份，
 * 但**保留先见到的 id**，免得 id 在两台机器之间来回漂移。
 */
export function mergeNotes(localDoc, remoteDoc) {
  const localList = Array.isArray(localDoc?.notes) ? localDoc.notes : [];
  const remoteList = Array.isArray(remoteDoc?.notes) ? remoteDoc.notes : [];
  const localIds = new Set(localList.map((n) => n.id));

  const combine = (a, b) => {
    const base = (b?.updatedAt || 0) > (a?.updatedAt || 0) ? b : a;
    const other = base === a ? b : a;
    const out = { ...base };
    // 只在「原来就有 / 合并后确实有值」时才写这些字段：
    // 否则会给一条本来没有 tags 的记忆补上 `tags: []`，字节变了 → 又是一次无谓提交。
    const tags = [...new Set([...(a.tags || []), ...(b.tags || [])])].slice(0, 8);
    if (tags.length) out.tags = tags;
    else delete out.tags;
    if (a.importance !== undefined || b.importance !== undefined) {
      out.importance = Math.max(a.importance || 3, b.importance || 3);
    }
    const sessionId = base.sessionId || other.sessionId;
    if (sessionId) out.sessionId = sessionId;
    else delete out.sessionId;
    return out;
  };

  const byId = new Map();
  for (const note of [...localList, ...remoteList]) {
    if (!note || !note.id) continue;
    const prev = byId.get(note.id);
    byId.set(note.id, prev ? combine(prev, note) : { ...note });
  }

  const keyOf = (n) => `${n.type || 'note'}|${String(n.text || '').replace(/\s+/g, ' ').trim().toLowerCase()}`;
  const byKey = new Map();
  const out = [];
  for (const note of byId.values()) {
    const key = keyOf(note);
    const prevSlot = byKey.get(key);
    if (prevSlot) {
      const merged = combine(prevSlot.note, note);
      const kept = { ...merged, id: prevSlot.id };
      out[prevSlot.index] = kept;
      byKey.set(key, { id: kept.id, note: kept, index: prevSlot.index });
      continue;
    }
    const slot = { id: note.id, note, index: out.length };
    byKey.set(key, slot);
    out.push(note);
  }

  const outById = new Map(out.map((n) => [n.id, n]));
  const added = out.filter((n) => !localIds.has(n.id)).length;
  const updated = localList.filter((local) => {
    const merged = outById.get(local.id);
    return !merged || JSON.stringify(merged) !== JSON.stringify(local);
  }).length;

  return {
    doc: { version: 1, updatedAt: localDoc?.updatedAt || remoteDoc?.updatedAt || null, notes: out },
    added,
    updated,
    total: out.length,
  };
}

/* ---------------------------------------------------------------- 状态 */

/**
 * 同步状态：面板「同步」模块的数据源。
 * 远端探测只做只读 fetch + 读 manifest，不动本地索引。
 */
/**
 * 同步状态（**只读本地，不联网**）：面板每次打开都会问，所以不能有 git 网络开销。
 * 远端情况由 `syncProbe()` 单独探测。
 */
export function syncStatus(indexDir = resolveIndexDir()) {
  const cfg = loadSyncConfig(indexDir);
  const resolved = resolveRepo(indexDir);
  const localCards = loadCards(indexDir);
  const localNotes = loadNotes(indexDir);
  return {
    configured: Boolean(resolved.repo),
    repo: resolved.repo,
    repoSource: resolved.source,
    branch: resolved.branch,
    machine: cfg.machine,
    lastPushAt: cfg.lastPushAt,
    lastPullAt: cfg.lastPullAt,
    gitAvailable: gitAvailable(),
    workdir: remoteDir(indexDir),
    local: {
      cards: Object.keys(localCards.cards || {}).length,
      notes: Array.isArray(localNotes.notes) ? localNotes.notes.length : 0,
      builtAt: localCards.builtAt || null,
      notesUpdatedAt: localNotes.updatedAt || null,
    },
    remote: null,
    reason: resolved.repo ? undefined : '未配置远端仓库',
  };
}

/**
 * 探测远端（有网络开销，单独调）：远端有没有内容、本机是不是落后。
 * @returns {Promise<{ok:boolean, sha?:string, localSha?:string, ahead?:boolean, manifest?:object, error?:string, hint?:string}>}
 */
export async function syncProbe(indexDir = resolveIndexDir()) {
  const resolved = resolveRepo(indexDir);
  if (!resolved.repo) return { ok: false, error: '未配置远端仓库' };
  if (!gitAvailable()) return { ok: false, error: '这台机器没有 git 命令' };
  const dir = remoteDir(indexDir);
  try {
    if (fs.existsSync(path.join(dir, '.git'))) {
      git(['fetch', 'origin', resolved.branch], { cwd: dir, timeout: 20000 });
      let manifest = null;
      let sha = null;
      try {
        sha = git(['rev-parse', 'FETCH_HEAD'], { cwd: dir }).trim();
        manifest = JSON.parse(git(['show', `${sha}:manifest.json`], { cwd: dir }));
      } catch {
        manifest = null;
      }
      let localSha = null;
      try {
        localSha = git(['rev-parse', 'HEAD'], { cwd: dir }).trim();
      } catch {
        localSha = null;
      }
      return {
        ok: true, sha, localSha,
        ahead: Boolean(sha && localSha && sha !== localSha),
        manifest,
      };
    }
    git(['ls-remote', '--heads', resolved.repo, resolved.branch], { timeout: 20000 });
    return { ok: true, cloned: false, manifest: null, ahead: false };
  } catch (err) {
    return { ok: false, error: err.message, hint: err.hint || '' };
  }
}

/**
 * 远端文件的**规范化序列化**。
 *
 * 两台机器的 `cards.json` / `notes.json` 内容一样但键序、记忆顺序可能不同，
 * 直接 `JSON.stringify` 会让对方每次拉完再推都「看起来有改动」→ 两台机器
 * 无限互相提交。所以进仓的字节必须是规范化的：对象键递归排序、记忆按
 * `updatedAt` 倒序再按 id 排。本地索引文件不动（那是本机自己写的）。
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

/**
 * 远端文件的**规范化序列化**。
 *
 * 两条规则，都是为了「同样的数据 → 同样的字节」，否则两台机器会互相提交：
 *
 *  1. **对象键递归排序、记忆按 `updatedAt` 倒序再按 id 排** —— 两台机器合并出的
 *     集合相同但插入顺序不同，直接 `JSON.stringify` 字节就不一样。
 *  2. **抹掉本机时间戳**（`cards.builtAt`、`notes.updatedAt`）—— 这两个字段是
 *     「本机最后一次写盘/构建」的时间，每次保存都会变；带进远端就成了
 *     你追我赶的时间戳提交。它们留在本机索引里，面板照常显示；
 *     远端的同步时间看 `manifest.json`。
 */
function remoteTexts(cards, notes) {
  const list = Array.isArray(notes?.notes) ? notes.notes : [];
  const sorted = [...list].sort(
    (a, b) => ((b.updatedAt || 0) - (a.updatedAt || 0)) || String(a.id).localeCompare(String(b.id)),
  );
  const cardsOut = { ...cards, builtAt: null, cards: cards?.cards || {} };
  const notesOut = { ...notes, updatedAt: null, notes: sorted };
  return {
    cards: JSON.stringify(canonicalize(cardsOut)),
    notes: JSON.stringify(canonicalize(notesOut)),
  };
}

/**
 * 把合并结果落盘到工作副本（含 manifest 与说明文件）。
 *
 * manifest **只在数据真变了、或本来就没有时才重写** —— 否则每次同步都会因为
 * 时间戳不同而多出一个提交，两台机器会互相推着对方的 manifest 无限提交下去。
 * 「数据变没变」交给 git 判定（比自己比对 JSON 稳，不受键序影响）。
 */
function writeWorkdir(dir, cards, notes) {
  const texts = remoteTexts(cards, notes);
  fs.writeFileSync(path.join(dir, 'cards.json'), texts.cards, 'utf8');
  fs.writeFileSync(path.join(dir, 'notes.json'), texts.notes, 'utf8');

  const manifestFile = path.join(dir, 'manifest.json');
  let dataDirty = true;
  try {
    dataDirty = git(['status', '--porcelain', '--', 'cards.json', 'notes.json'], { cwd: dir }).trim() !== '';
  } catch {
    dataDirty = true;
  }
  if (dataDirty || !fs.existsSync(manifestFile)) {
    writeJson(manifestFile, manifestOf({ cards, notes }));
  }

  const readme = path.join(dir, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, [
      '# dsh-session-index 数据仓（自动同步）',
      '',
      '这是 `dsh-session-index` 插件的**跨终端数据同步仓**，由插件自动提交与推送。',
      '',
      '- `cards.json` 会话卡（标题 / 结论 / 提问 / 涉及路径 / 关键词）',
      '- `notes.json` 长期记忆（`session_index_remember` 写的）',
      '- `manifest.json` 最近一次同步的机器、时间与条数',
      '',
      '**这个仓必须保持 Private**：会话卡里有结论与路径，等同会话内容摘要。',
      '不要手工改这三个文件（下次同步会按合并语义覆盖）。',
      '',
    ].join('\n'), 'utf8');
  }
}

/** 把合并结果写回本地索引（只在真有变化时写，避免每次同步都留一份备份）。 */
function persistLocal(indexDir, cards, notes) {
  if (cards.added || cards.updated) saveCards(indexDir, cards.doc);
  if (notes.added || notes.updated) saveNotes(indexDir, notes.doc);
}

/* ---------------------------------------------------------------- 推 / 拉 */

/**
 * 上传：本地与远端 union 合并 → 写回本地 → 提交 → 推。
 * 远端有新提交（另一台机器刚推过）时自动再合一次重推。
 */
export function syncPush(indexDir = resolveIndexDir()) {
  const cfg = loadSyncConfig(indexDir);
  const resolved = resolveRepo(indexDir);
  if (!resolved.repo) throw new SyncError('未配置远端仓库', '先在面板「同步」里填一个 Private 仓地址。');
  if (!gitAvailable()) throw new SyncError('这台机器没有 git 命令', '安装 git 后重试。');

  const dir = ensureClone(indexDir, { repo: resolved.repo, branch: resolved.branch });
  const remote = readRemote(dir);
  const localCards = loadCards(indexDir);
  const localNotes = loadNotes(indexDir);

  const cards = mergeCards(localCards, remote.cards);
  const notes = mergeNotes(localNotes, remote.notes);
  persistLocal(indexDir, cards, notes);
  writeWorkdir(dir, cards.doc, notes.doc);

  git(['add', '-A'], { cwd: dir });
  const status = git(['status', '--porcelain'], { cwd: dir });
  if (!status.trim()) {
    saveSyncConfig({ lastPushAt: new Date().toISOString() }, indexDir);
    return {
      ok: true, changed: false, added: cards.added, updated: cards.updated,
      notesAdded: notes.added, notesUpdated: notes.updated,
      cards: cards.total, notes: notes.total, commit: null,
    };
  }

  const msg = `sync: ${cards.total} cards / ${notes.total} notes from ${os.hostname()}`;
  git(['commit', '-m', msg], { cwd: dir });
  let commit = git(['rev-parse', '--short', 'HEAD'], { cwd: dir }).trim();

  try {
    git(['push', 'origin', resolved.branch], { cwd: dir, timeout: 120000 });
  } catch (err) {
    if (!/fetch first|non-fast-forward|rejected|cannot lock ref/i.test(String(err.message))) throw err;
    // 远端有新提交 → 工作副本对齐远端，重新合并后再推（真相在 indexDir，对齐是安全的）
    git(['fetch', 'origin', resolved.branch], { cwd: dir, timeout: 120000 });
    git(['checkout', '-B', resolved.branch, 'FETCH_HEAD'], { cwd: dir });
    const again = readRemote(dir);
    const mergedCards = mergeCards(loadCards(indexDir), again.cards);
    const mergedNotes = mergeNotes(loadNotes(indexDir), again.notes);
    persistLocal(indexDir, mergedCards, mergedNotes);
    writeWorkdir(dir, mergedCards.doc, mergedNotes.doc);
    git(['add', '-A'], { cwd: dir });
    if (git(['status', '--porcelain'], { cwd: dir }).trim()) {
      git(['commit', '-m', msg], { cwd: dir });
    }
    git(['push', 'origin', resolved.branch], { cwd: dir, timeout: 120000 });
    commit = git(['rev-parse', '--short', 'HEAD'], { cwd: dir }).trim();
  }

  saveSyncConfig({ lastPushAt: new Date().toISOString() }, indexDir);
  return {
    ok: true, changed: true, added: cards.added, updated: cards.updated,
    notesAdded: notes.added, notesUpdated: notes.updated,
    cards: cards.total, notes: notes.total, commit,
  };
}

/** 拉取：取远端最新 → union 合并 → 写回本地索引。 */
export function syncPull(indexDir = resolveIndexDir()) {
  const cfg = loadSyncConfig(indexDir);
  const resolved = resolveRepo(indexDir);
  if (!resolved.repo) throw new SyncError('未配置远端仓库', '先在面板「同步」里填一个 Private 仓地址。');
  if (!gitAvailable()) throw new SyncError('这台机器没有 git 命令', '安装 git 后重试。');

  const dir = ensureClone(indexDir, { repo: resolved.repo, branch: resolved.branch });
  const remote = readRemote(dir);
  if (!remote.cards && !remote.notes) {
    throw new SyncError('远端仓里没有数据', '先在另一台机器点一次「上传」，或确认分支没错。');
  }

  const localCards = loadCards(indexDir);
  const localNotes = loadNotes(indexDir);
  const cards = mergeCards(localCards, remote.cards);
  const notes = mergeNotes(localNotes, remote.notes);
  persistLocal(indexDir, cards, notes);

  saveSyncConfig({ lastPullAt: new Date().toISOString() }, indexDir);
  return {
    ok: true,
    added: cards.added,
    updated: cards.updated,
    notesAdded: notes.added,
    notesUpdated: notes.updated,
    cards: cards.total,
    notes: notes.total,
    manifest: remote.manifest || null,
  };
}

/* ---------------------------------------------------------------- 本地包 */

/** 本地导出 zip（不上 git 时的手动搬运方式）。 */
export function exportZip(indexDir = resolveIndexDir(), outDir = null) {
  const cards = loadCards(indexDir);
  const notes = loadNotes(indexDir);
  const manifest = manifestOf({ cards, notes });
  const entries = [
    { name: 'cards.json', data: JSON.stringify(cards) },
    { name: 'notes.json', data: JSON.stringify(notes) },
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
    {
      name: 'README.txt',
      data: [
        'dsh-session-index 数据包（本地导出）',
        '',
        `导出时间：${manifest.updatedAt}`,
        `机器：${manifest.machine}`,
        `会话卡：${manifest.cards} 张 / 记忆：${manifest.notes} 条`,
        '',
        '在另一台装好 dsh-session-index 的机器上，用面板「同步 → 导入合并」打开这个包',
        '（做的是合并，不会覆盖那边的新数据）。',
        '',
      ].join('\n'),
    },
  ];
  const dir = outDir || path.join(indexDir, 'exports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `session-index-data-${stamp}.zip`);
  const zip = createZip(entries);
  fs.writeFileSync(file, zip);
  return { ok: true, file, bytes: zip.length, cards: manifest.cards, notes: manifest.notes, manifest };
}

/** 极简 zip 解包（只支持本插件 `createZip` 写出的 deflate / stored 条目）。 */
export function readZip(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new SyncError('不是有效的 zip（找不到中央目录结尾）');
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    try {
      out[name] = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
    } catch {
      /* 单个条目坏了不影响其它 */
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 导入一个导出的 zip（合并，不覆盖）。 */
export function importZip(file, indexDir = resolveIndexDir()) {
  if (!fs.existsSync(file)) throw new SyncError(`找不到文件：${file}`);
  const entries = readZip(file);
  const parse = (name) => {
    const buf = entries[name];
    if (!buf) return null;
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      return null;
    }
  };
  const remoteCards = parse('cards.json');
  const remoteNotes = parse('notes.json');
  if (!remoteCards && !remoteNotes) throw new SyncError('这个包里没有 cards.json / notes.json');

  const localCards = loadCards(indexDir);
  const localNotes = loadNotes(indexDir);
  const cards = mergeCards(localCards, remoteCards);
  const notes = mergeNotes(localNotes, remoteNotes);
  persistLocal(indexDir, cards, notes);
  return {
    ok: true,
    added: cards.added,
    updated: cards.updated,
    notesAdded: notes.added,
    notesUpdated: notes.updated,
    cards: cards.total,
    notes: notes.total,
    manifest: parse('manifest.json'),
  };
}

export const __test = { mergeCards, mergeNotes, readZip, manifestOf, loadSyncConfig, saveSyncConfig };