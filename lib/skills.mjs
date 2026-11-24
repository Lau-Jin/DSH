/**
 * 技能文件检索 —— 「这台机器上有哪些 skill？装在哪？里面写了什么？缺了怎么导入？」
 *
 * 背景：这台机器的技能散在**多个根**里（同一份 debug-helper 同时在 .dsh / .agents / .codebuddy），
 * 目录名还可能是符号链接。要回答「有哪些技能」必须先知道有哪些根、再逐个扫，
 * 而「同名出现在多个根」是常态，不是异常 —— 所以这里的核心是**合并**：
 *
 *   1. `skillRoots()`      —— 列出所有技能根（用户根 / 项目根 / 环境变量追加）；
 *   2. `listSkills()`      —— 扫全部根，**同名合并成一条**，标出它出现在哪几个根、
 *                              哪个是「主副本」（DSH 优先），并统计子文件；
 *   3. `searchSkills()`    —— 在 SKILL.md 与 references/*.md 里做**文件级检索**
 *                              （关键词命中 + 上下文片段 + 文件路径 + 行号）；
 *   4. `importSkill()`     —— 从目录或 zip **导入**到指定技能根（同名默认不覆盖）；
 *   5. `skillCatalog()`    —— 把合并后的清单落一份到索引目录（`skills.json`），
 *                              供面板与跨终端参考。
 *
 * 全部零依赖：frontmatter 用简单的行解析，zip 解压走系统 `tar`（Windows 自带 bsdtar 支持 zip）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 用户级技能根。顺序即**优先级**：越靠前越「权威」。 */
const USER_ROOTS = [
  { id: 'dsh:user', path: () => path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'skills') },
  { id: 'agents:user', path: () => path.join(os.homedir(), '.agents', 'skills') },
  { id: 'codebuddy:user', path: () => path.join(os.homedir(), '.codebuddy', 'skills') },
  { id: 'claude:user', path: () => path.join(os.homedir(), '.claude', 'skills') },
  { id: 'codex:user', path: () => path.join(os.homedir(), '.codex', 'skills') },
  { id: 'cursor:user', path: () => path.join(os.homedir(), '.cursor', 'skills') },
];

/** 项目级技能根（在当前工作区里找）。 */
const PROJECT_ROOT_DIRS = ['.dsh', '.agents', '.claude', '.codex', '.cursor', '.codebuddy'];

/**
 * 所有技能根。
 * 环境变量 `SESSION_INDEX_SKILL_ROOTS`（`;` 或 `,` 分隔）可**追加**自定义根。
 */
export function skillRoots({ cwd = process.cwd() } = {}) {
  const roots = [];
  for (const root of USER_ROOTS) {
    const p = root.path();
    roots.push({ id: root.id, path: p, kind: 'user', exists: fs.existsSync(p) });
  }
  for (const dir of PROJECT_ROOT_DIRS) {
    const p = path.join(cwd, dir, 'skills');
    if (fs.existsSync(p)) roots.push({ id: `project:${dir}`, path: p, kind: 'project', exists: true });
  }
  const extra = String(process.env.SESSION_INDEX_SKILL_ROOTS || '')
    .split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  for (const p of extra) {
    roots.push({ id: `env:${path.basename(p)}`, path: p, kind: 'custom', exists: fs.existsSync(p) });
  }
  return roots;
}

/* ---------------------------------------------------------------- frontmatter */

/**
 * 解析 YAML frontmatter（只取平铺的 `key: value`，够 SKILL.md 用）。
 * 返回 `{ data, body }`；没有 frontmatter 时 data 为空对象。
 */
export function parseFrontmatter(text) {
  const src = String(text || '');
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
  if (!m) return { data: {}, body: src };
  const data = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      let value = kv[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      data[key] = value;
      continue;
    }
    // 续行（列表或折行）：接到上一个 key 上
    if (key && /^\s+/.test(line)) {
      const cont = line.trim();
      if (cont.startsWith('- ')) {
        if (!Array.isArray(data[key])) data[key] = data[key] ? `${data[key]}`.split('\n') : [];
        data[key].push(cont.slice(2).trim());
      } else {
        data[key] = `${data[key] || ''} ${cont}`.trim();
      }
    }
  }
  return { data, body: m[2] || '' };
}

/* ---------------------------------------------------------------- 扫描 */

/** 一个技能目录里有哪些文件（相对路径）。 */
function listSkillFiles(dir, { max = 200 } = {}) {
  const out = [];
  const walk = (current, depth) => {
    if (depth > 4 || out.length >= max) return;
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile()) out.push(path.relative(dir, full).replace(/\\/g, '/'));
    }
  };
  walk(dir, 0);
  return out.sort();
}

/** 读一个技能：frontmatter + 正文 + 文件清单。 */
function readSkillDir(dir, root) {
  const skillFile = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) return null;
  let text = '';
  let mtime = 0;
  try {
    text = fs.readFileSync(skillFile, 'utf8');
    mtime = fs.statSync(skillFile).mtimeMs;
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(text);
  const files = listSkillFiles(dir);
  let bytes = 0;
  for (const f of files) {
    try { bytes += fs.statSync(path.join(dir, f)).size; } catch { /* 忽略 */ }
  }
  return {
    name: data.name || path.basename(dir),
    description: data.description || '',
    version: data.version || '',
    whenToUse: data.whenToUse || '',
    dir,
    rootId: root.id,
    rootPath: root.path,
    skillFile: path.relative(root.path, skillFile).replace(/\\/g, '/'),
    files,
    fileCount: files.length,
    bytes,
    bodyLength: body.length,
    updatedAt: mtime,
    isSymlink: (() => { try { return fs.lstatSync(dir).isSymbolicLink(); } catch { return false; } })(),
  };
}

/**
 * 列出所有技能（**同名合并**）。
 * @param {{query?: string, roots?: Array}} [options]
 */
export function listSkills(options = {}) {
  const roots = options.roots || skillRoots();
  const merged = new Map();
  const rootStats = [];

  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root.path, { withFileTypes: true }); } catch { /* 根不存在 */ }
    let count = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const dir = path.join(root.path, entry.name);
      const skill = readSkillDir(dir, root);
      if (!skill) continue;
      count += 1;
      const key = skill.name.toLowerCase();
      const prev = merged.get(key);
      if (!prev) {
        merged.set(key, { ...skill, roots: [root.id], rootPaths: [root.path], primaryRoot: root.id, primaryPath: dir, duplicates: 0 });
        continue;
      }
      // 同名：合并来源（这才是「合并在一起」的核心），保留优先级最高的那个作主副本
      prev.roots.push(root.id);
      prev.rootPaths.push(root.path);
      prev.duplicates += 1;
      if (!prev.description && skill.description) prev.description = skill.description;
      if (!prev.version && skill.version) prev.version = skill.version;
      prev.fileCount = Math.max(prev.fileCount, skill.fileCount);
      prev.bytes = Math.max(prev.bytes, skill.bytes);
      prev.updatedAt = Math.max(prev.updatedAt, skill.updatedAt);
    }
    rootStats.push({ id: root.id, path: root.path, kind: root.kind, exists: root.exists, skills: count });
  }

  let skills = [...merged.values()];
  if (options.query) {
    const q = String(options.query).toLowerCase();
    skills = skills.filter((s) => s.name.toLowerCase().includes(q)
      || String(s.description).toLowerCase().includes(q)
      || String(s.whenToUse).toLowerCase().includes(q));
  }
  skills.sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    ok: true,
    roots: rootStats,
    total: skills.length,
    duplicates: skills.filter((s) => s.duplicates > 0).length,
    skills,
  };
}

/* ---------------------------------------------------------------- 检索 */

/** 把一条命中切成前后片段。 */
function snippetAround(text, index, radius = 90) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return {
    text: (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : ''),
    offset: start,
  };
}

/**
 * 在技能文件里检索（SKILL.md + references/*.md 等全部文本文件）。
 * @param {{query: string, limit?: number, roots?: Array}} options
 */
export function searchSkills({ query, limit = 20, roots } = {}) {
  const text = String(query || '').trim();
  if (!text) return { ok: false, error: 'search 要带关键词', hits: [], total: 0 };
  const needles = text.toLowerCase().split(/\s+/).filter(Boolean);
  const catalog = listSkills({ roots });
  const hits = [];

  for (const skill of catalog.skills) {
    for (const rel of skill.files) {
      if (!/\.(md|markdown|txt|json|ya?ml)$/i.test(rel)) continue;
      const full = path.join(skill.primaryPath, rel);
      let content = '';
      try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
      if (content.length > 2_000_000) content = content.slice(0, 2_000_000);
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const lower = line.toLowerCase();
        if (!needles.some((n) => lower.includes(n))) continue;
        const hit = {
          skill: skill.name,
          description: skill.description,
          file: rel,
          absolutePath: full,
          line: i + 1,
          lineText: line.trim().slice(0, 240),
          snippet: snippetAround(content, content.indexOf(line)).text,
          root: skill.primaryRoot,
          path: skill.primaryPath,
        };
        hits.push(hit);
        if (hits.length >= limit * 4) break;
      }
      if (hits.length >= limit * 4) break;
    }
    if (hits.length >= limit * 4) break;
  }

  const trimmed = hits.slice(0, limit);
  return {
    ok: true,
    query: text,
    total: hits.length,
    returned: trimmed.length,
    hits: trimmed,
    skillsSearched: catalog.total,
    hint: '命中给的是文件与行号；要整份读用 get（sessionId 不适用时直接读该文件）',
  };
}

/* ---------------------------------------------------------------- 导入 */

/** 解压 zip 到临时目录（用系统 tar；Windows 自带 bsdtar 支持 zip）。 */
async function extractZip(zipPath, targetDir) {
  await execFileAsync('tar', ['-xf', zipPath, '-C', targetDir], { timeout: 120000, windowsHide: true });
}

/**
 * 在目录里找到含 SKILL.md 的那一层。
 * zip 里常多包几层（`pkg/gamma/SKILL.md`），所以要**递归找最浅的那一层**。
 */
function findSkillRoot(dir, depth = 0) {
  if (depth > 3) return null;
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) return dir;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const child = path.join(dir, entry.name);
    const found = findSkillRoot(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/** 复制目录（递归）。 */
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

/**
 * 导入一个技能（从目录或 zip）。
 * @param {{source: string, targetRoot?: string, name?: string, overwrite?: boolean}} options
 */
export async function importSkill({ source, targetRoot, name, overwrite = false } = {}) {
  const src = String(source || '').trim();
  if (!src) return { ok: false, error: 'import 要带 source（目录或 zip 的路径）' };
  if (!fs.existsSync(src)) return { ok: false, error: `路径不存在：${src}` };

  const roots = skillRoots();
  const defaultRoot = roots.find((r) => r.id === 'dsh:user')?.path
    || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'skills');
  const destRoot = String(targetRoot || defaultRoot).trim();
  fs.mkdirSync(destRoot, { recursive: true });

  let tempDir = '';
  let sourceDir = '';
  try {
    if (fs.statSync(src).isDirectory()) {
      sourceDir = src;
    } else if (/\.zip$/i.test(src)) {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-skill-'));
      await extractZip(src, tempDir);
      sourceDir = findSkillRoot(tempDir) || tempDir;
    } else {
      return { ok: false, error: '只支持目录或 .zip' };
    }

    const skillDir = findSkillRoot(sourceDir);
    if (!skillDir) return { ok: false, error: '源里没有 SKILL.md，不是一个技能包' };

    const { data } = parseFrontmatter(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'));
    const skillName = String(name || data.name || path.basename(skillDir)).trim();
    if (!/^[A-Za-z0-9._-]+$/.test(skillName)) {
      return { ok: false, error: `技能名不合法：${skillName}（只允许字母数字 . _ -）` };
    }
    const dest = path.join(destRoot, skillName);
    if (fs.existsSync(dest) && !overwrite) {
      return {
        ok: false, error: `目标已存在：${dest}`,
        hint: '同名已存在时默认不覆盖；确认要覆盖就带 overwrite: true，或先改名',
        existing: dest,
      };
    }
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    copyDir(skillDir, dest);

    const files = listSkillFiles(dest);
    return {
      ok: true,
      imported: skillName,
      from: src,
      to: dest,
      targetRoot: destRoot,
      files: files.length,
      bytes: files.reduce((n, f) => { try { return n + fs.statSync(path.join(dest, f)).size; } catch { return n; } }, 0),
      description: data.description || '',
      version: data.version || '',
      hint: '已导入到 DSH 技能根，重启 DSH（或重新载入技能）后即可用',
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  } finally {
    if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  }
}

/* ---------------------------------------------------------------- 清单落盘 */

/**
 * 把合并后的技能清单写到索引目录（`skills.json`）——
 * 面板与 agent 都能读；**只存清单与路径，不存正文**（技能正文可能很大，且属于本机文件）。
 */
export function writeCatalog(indexDir) {
  const catalog = listSkills();
  const payload = {
    version: 1,
    builtAt: new Date().toISOString(),
    roots: catalog.roots,
    total: catalog.total,
    duplicates: catalog.duplicates,
    skills: catalog.skills.map((s) => ({
      name: s.name, description: s.description, version: s.version, whenToUse: s.whenToUse,
      roots: s.roots, primaryRoot: s.primaryRoot, primaryPath: s.primaryPath,
      fileCount: s.fileCount, bytes: s.bytes, updatedAt: s.updatedAt, duplicates: s.duplicates,
      files: s.files.slice(0, 40),
    })),
  };
  const file = path.join(indexDir, 'skills.json');
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { ok: true, file, total: payload.total, roots: payload.roots.length, duplicates: payload.duplicates };
}

/** 读已落盘的清单（没写过就现生成一份）。 */
export function readCatalog(indexDir) {
  const file = path.join(indexDir, 'skills.json');
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* 坏了就重建 */ }
  writeCatalog(indexDir);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { skills: [], roots: [], total: 0 }; }
}
