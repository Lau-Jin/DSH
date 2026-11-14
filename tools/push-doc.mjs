/**
 * 把任意文档（Markdown / HTML）推送到思源桥「待入库」队列。
 *
 * 三种用法：
 *   node tools/push-doc.mjs                              单文件预览（默认《操作使用手册.html》）
 *   node tools/push-doc.mjs --file README.md --send     推送任意单个文档
 *   node tools/push-doc.mjs --from-workbuddy            批量：列出 WorkBuddy 会话文档（只读）
 *   node tools/push-doc.mjs --from-workbuddy --send     批量：全部投递到待入库
 *
 * 批量数据源：~/.workbuddy/artifact-index/<会话id>.json 的 contentType=document 条目。
 * 默认排除临时验证目录/依赖目录/旧开发副本，按内容哈希去重，避免把同一份 README
 * 推十几遍。用 --no-exclude 关闭排除，--source 按生成方式收窄，--limit 设上限。
 *
 * 可控点：默认 dry-run；--send 才入队；投递前逐篇查重；
 *         **永远不调用 /api/stage/commit**，写入思源笔记库由人在界面确认。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (...names) => names.some((n) => argv.includes(n));
const SEND = has('--send');
const BATCH = has('--from-workbuddy');
const NO_EXCLUDE = has('--no-exclude');
const FORCE = has('--force');
const LIMIT = Math.max(1, Math.min(500, Number(arg('--limit', 60)) || 60));
const SOURCE = arg('--source', '');
const SINCE = Number(arg('--since', 0)) || 0;
const FILE = path.resolve(ROOT, arg('--file', '操作使用手册.html'));
const BRIDGE = (process.env.SIYUAN_BRIDGE_URL || `http://127.0.0.1:${process.env.SIYUAN_BRIDGE_PORT || 5599}`).replace(/\/+$/, '');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const HPATH = arg('--hpath', process.env.SESSION_INDEX_STAGE_HPATH || '/会话札记/思源');
const NOTEBOOK = arg('--notebook', '思源桥');
const TITLE_OVERRIDE = arg('--title', '');
const OUT_DIR = path.join(ROOT, 'dist');

/** 默认排除：临时验证副本、依赖目录、旧开发副本、UI 源码。 */
const EXCLUDE = [
  /(^|\/)(node_modules|dist|\.git|__pycache__)(\/|$)/i,
  /(^|\/)\.verify-/i,
  /(^|\/)DSH-probe(\/|$)/i,
  /(^|\/)dsh-session-index(\/|$)/i,
  /(^|\/)backup-/i,
  /\.backup-/i,
  /\.audit-/i,
  /(^|\/)service\/public\//i,
];

const api = async (p, init) => {
  const r = await fetch(BRIDGE + p, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p} → HTTP ${r.status}: ${j.error || r.statusText}`);
  return j;
};
const post = (p, body) => api(p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const sha = (s) => createHash('sha256').update(s).digest('hex');
const cleanTitle = (s) => String(s).replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 110);

/** 把 HTML 正文裁干净后用思源桥自带转换器（只读）转 Markdown；MD 原样返回。 */
async function toMarkdown(raw, label) {
  const isHtml = /^\s*<(!doctype|html|main|div|h[1-6])/i.test(raw);
  if (!isHtml) return raw.trim();
  const main = /<main>([\s\S]*?)<\/main>/i.exec(raw)?.[1] || raw;
  const cleaned = main
    .replace(/<button\b[^>]*>[\s\S]*?<\/button>/gi, '')
    .replace(/<div class="badges">[\s\S]*?<\/div>\s*<\/header>/i, '</header>')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/\sdata-kw="[^"]*"/g, '')
    .trim();
  const converted = (await post('/api/paste/html', { html: cleaned })).markdown || '';
  return converted.replace(/^\s*#\s+[^\n]*操作使用手册[^\n]*\s*\n/m, '').trim() || `# ${label}`;
}

/** 组装一篇待投递文档：统一头部元信息 + 正文。 */
async function buildDoc(raw, { title, origin, conv }) {
  const body = await toMarkdown(raw, title);
  const header = [
    `# ${title}`,
    '',
    `> 来源：\`${origin}\`${conv ? ` · 会话 ${conv.slice(0, 8)}` : ''} · 插件 v${VERSION}`,
    `> 转换：${/^\s*</.test(raw) ? '思源桥内置 HTML→Markdown' : '原样 Markdown'} · ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    '> 状态：**仅进入待入库队列，未写入思源笔记库**，请在界面确认后再落库。',
    '',
    '---',
    '',
    '',
  ].join('\n');
  const markdown = `${header}${body}\n`;
  const problems = [];
  for (const bad of ['已复制', 'btn.textContent', 'data-kw', '@media', '<style', 'function(']) {
    const n = markdown.split(bad).length - 1;
    if (n) problems.push(`${bad} × ${n}`);
  }
  return { title, markdown, problems, chars: markdown.length };
}

function shortPath(abs) {
  const marker = 'Tool开发';
  const i = abs.replace(/\\/g, '/').lastIndexOf(marker);
  return i === -1 ? path.basename(abs) : abs.replace(/\\/g, '/').slice(i + marker.length + 1);
}

/** 从 WorkBuddy 产物索引收集文档。 */
function collectWorkbuddyDocs() {
  const dir = process.env.WORKBUDDY_ARTIFACT_INDEX
    || path.join(os.homedir(), '.workbuddy', 'artifact-index');
  if (!fs.existsSync(dir)) throw new Error(`找不到 WorkBuddy 产物索引：${dir}`);
  const seenHash = new Set();
  const seenPath = new Set();
  const docs = [];
  let rawCount = 0;
  let excluded = 0;
  let missing = 0;
  let dup = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    const conv = f.replace(/\.json$/, '');
    for (const a of j.artifacts || []) {
      const docExt = has('--include-txt') ? /\.(md|markdown|html?|txt)$/i : /\.(md|markdown|html?)$/i;
      if (a.contentType !== 'document' || !docExt.test(a.name || '')) continue;
      if (SOURCE && String(a._meta?.sourceTool || '') !== SOURCE) continue;
      if (SINCE && Number(a.updatedAt || 0) < SINCE) continue;
      rawCount++;
      let abs;
      try {
        abs = decodeURIComponent(String(a.uri || '').replace(/^file:\/\/\//, '')).replace(/\//g, path.sep);
      } catch {
        continue;
      }
      const rel = String(a.uri || '').replace(/^file:\/\/\//, '');
      if (!NO_EXCLUDE && EXCLUDE.some((re) => re.test(rel))) { excluded++; continue; }
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { missing++; continue; }
      const key = abs.toLowerCase();
      if (seenPath.has(key)) { dup++; continue; }
      const raw = fs.readFileSync(abs, 'utf8');
      const h = sha(raw);
      if (seenHash.has(h)) { dup++; continue; }
      seenPath.add(key);
      seenHash.add(h);
      const relShort = shortPath(abs);
      const label = path.basename(abs);
      docs.push({
        abs, raw, conv,
        relShort,
        title: cleanTitle(TITLE_OVERRIDE || `${label.replace(/\.[^.]+$/, '')} · ${relShort}`),
        origin: relShort,
      });
    }
  }
  return { docs, stats: { dir, rawCount, excluded, missing, dup, unique: docs.length } };
}

async function deliver(doc, queue) {
  if (doc.problems.length) return { skipped: true, why: '含杂质：' + doc.problems.join(', ') };
  if (doc.chars > 256 * 1024) return { skipped: true, why: '超过 256 KiB' };
  if (!SEND) return { skipped: true, why: 'dry-run（未写入）' };
  const same = queue.filter((it) => String(it.title).trim() === doc.title);
  if (same.length && !FORCE) {
    // 思源桥会规整 Markdown，队列里的 chars 与发送时未必相等，所以按标题判重更可靠
    return { skipped: true, why: '队列中已有同名稿（--force 可再投）' };
  }
  if (!SEND) return { skipped: true, why: 'dry-run' };
  const r = await post('/api/stage', {
    title: doc.title, markdown: doc.markdown, notebook: NOTEBOOK, hpath: HPATH,
    note: `WorkBuddy 会话产物 · ${doc.conv.slice(0, 8)} · v${VERSION} · 待人工确认`,
  });
  queue.push({ title: doc.title, chars: doc.chars });
  return { staged: true, id: r.id, chars: r.chars };
}

// ------------------------------------------------------------------ 主流程

const queue = (await api('/api/stage')).items || [];
let jobs;

if (BATCH) {
  const { docs, stats } = collectWorkbuddyDocs();
  console.log('=== WorkBuddy 会话文档扫描 ===');
  console.log(`索引目录：${stats.dir}`);
  console.log(`命中文档条目 ${stats.rawCount} · 排除临时/依赖目录 ${stats.excluded} · 文件已不存在 ${stats.missing} · 路径或内容重复 ${stats.dup}`);
  console.log(`唯一可推送 ${stats.unique} 篇，本次上限 ${LIMIT} 篇${NO_EXCLUDE ? '（已关闭默认排除）' : ''}${SOURCE ? ` · 仅 ${SOURCE}` : ''}`);
  jobs = docs.slice(0, LIMIT);
  if (!jobs.length) {
    console.log('\n没有可推送的文档。');
    process.exit(0);
  }
  console.log('\n清单：');
  jobs.forEach((d, i) => console.log(`  ${String(i + 1).padStart(2)}. [${d.conv.slice(0, 8)}] ${d.title}`));
  fs.mkdirSync(OUT_DIR, { recursive: true });
} else {
  if (!fs.existsSync(FILE)) throw new Error(`找不到文件：${FILE}`);
  const raw = fs.readFileSync(FILE, 'utf8');
  const base = path.basename(FILE);
  jobs = [{
    raw, conv: '', relShort: shortPath(FILE), origin: base,
    title: cleanTitle(TITLE_OVERRIDE || (/\.html?$/i.test(FILE)
      ? `dsh-session-index 操作使用手册 v${VERSION}` : base.replace(/\.[^.]+$/, ''))),
  }];
}

const results = [];
for (const j of jobs) {
  const doc = await buildDoc(j.raw, { title: j.title, origin: BATCH ? j.origin : j.relShort, conv: j.conv });
  if (!BATCH) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'push-doc-preview.md'), doc.markdown, 'utf8');
    console.log(`\n文件：${FILE}`);
    console.log(`转换：${j.raw.length} → ${doc.chars} 字 · 章节标题 ${doc.markdown.split('\n').filter((l) => /^#{1,3} /.test(l)).length} 个`);
    console.log(`杂质检查：${doc.problems.length ? doc.problems.join(', ') : '干净 ✓'}`);
    console.log(`预览：${path.join(OUT_DIR, 'push-doc-preview.md')}`);
    console.log(`\n--- 前 12 行 ---\n${doc.markdown.split('\n').slice(0, 12).join('\n')}`);
  }
  results.push({ title: doc.title, ...(await deliver({ ...doc, conv: j.conv || '' }, queue)) });
}

if (BATCH) {
  const staged = results.filter((r) => r.staged);
  const skipped = results.filter((r) => r.skipped);
  const reasons = new Map();
  for (const r of skipped) reasons.set(r.why, (reasons.get(r.why) || 0) + 1);
  console.log(`\n=== 结果 ===`);
  console.log(`投递成功 ${staged.length} 篇 / 跳过 ${skipped.length} 篇 / 队列现有 ${queue.length} 篇`);
  for (const [why, n] of reasons) console.log(`  ${why}: ${n}`);
  if (staged.length) console.log(`  首篇 id=${staged[0].id} · 落点=${HPATH}`);
  if (!SEND) console.log('\n[只读预览] 未产生任何写入。确认清单后加 --send 才批量投递。');
  else console.log('\n未调用 commit；请在思源桥「待入库」界面逐篇或批量勾选写入。');
} else {
  const r = results[0];
  if (r.staged) console.log(`\n已投递：id=${r.id} · chars=${r.chars} · hpath=${HPATH}\n未调用 commit。`);
  else console.log(`\n未投递：${r.why}`);
  if (!SEND) console.log('[只读预览] 确认后加 --send 才进入待入库队列。');
}
