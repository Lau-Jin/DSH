/**
 * 把本地文档（Markdown / HTML）推送到思源桥「待入库」队列。
 *
 * 用法（在仓库任意目录执行都行，路径基于脚本自身解析）：
 *   node tools/push-doc.mjs                         只读预览《操作使用手册.html》
 *   node tools/push-doc.mjs --send                 投递到待入库（绝不写库）
 *   node tools/push-doc.mjs --file README.md --dry
 *   node tools/push-doc.mjs --file docs/x.html --hpath "/会话札记/运维" --send
 *
 * 可控点：默认 --dry（只生成预览，不产生任何写入）；--send 才入队；
 *         投递前按「标题 + 字数」查重；**永远不调用 /api/stage/commit**。
 *
 * HTML 会先裁掉 <nav>/<button>/<script>/<style>/统计卡，再用思源桥自带的
 * /api/paste/html 转换器（只读）生成 Markdown，避免把导航和按钮文字塞进笔记。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const SEND = argv.includes('--send');
const FILE = path.resolve(ROOT, arg('--file', '操作使用手册.html'));
const BRIDGE = (process.env.SIYUAN_BRIDGE_URL || `http://127.0.0.1:${process.env.SIYUAN_BRIDGE_PORT || 5599}`).replace(/\/+$/, '');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const TITLE_OVERRIDE = arg('--title', '');
const HPATH = arg('--hpath', process.env.SESSION_INDEX_STAGE_HPATH || '/会话札记/思源');
const NOTEBOOK = arg('--notebook', '思源桥');
const OUT = path.join(ROOT, 'dist', 'push-doc-preview.md');

if (!fs.existsSync(FILE)) throw new Error(`找不到文件：${FILE}`);
const raw = fs.readFileSync(FILE, 'utf8');
const isHtml = /\.html?$/i.test(FILE) || /^\s*<(!doctype|html|main|div|h[1-6])/i.test(raw);

const api = async (p, init) => {
  const r = await fetch(BRIDGE + p, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p} → HTTP ${r.status}: ${j.error || r.statusText}`);
  return j;
};
const post = (p, body) => api(p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

let markdown = raw;
if (isHtml) {
  const main = /<main>([\s\S]*?)<\/main>/i.exec(raw)?.[1] || raw;
  const cleaned = main
    .replace(/<button\b[^>]*>[\s\S]*?<\/button>/gi, '')
    .replace(/<div class="badges">[\s\S]*?<\/div>\s*<\/header>/i, '</header>')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/\sdata-kw="[^"]*"/g, '')
    .trim();
  const converted = (await post('/api/paste/html', { html: cleaned })).markdown || '';
  markdown = converted.replace(/^\s*#\s+[^\n]*操作使用手册[^\n]*\s*\n/m, '').trim();
} else {
  markdown = raw.trim();
}

const base = path.basename(FILE);
const title = (TITLE_OVERRIDE || (isHtml ? `dsh-session-index 操作使用手册 v${VERSION}` : base.replace(/\.[^.]+$/, '')))
  .replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 120);
const header = [
  `# ${title}`,
  '',
  `> 原文：\`${base}\` · 版本 v${VERSION}`,
  `> 转换：${isHtml ? '思源桥内置 HTML→Markdown' : '原样 Markdown'} · ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
  '> 状态：**仅进入待入库队列，未写入思源笔记库**，请在界面确认后再落库。',
  '',
  '---',
  '',
  '',
].join('\n');
markdown = `${header}${markdown}\n`;

const problems = [];
for (const bad of ['已复制', 'btn.textContent', 'data-kw', '@media', '<style', 'function(']) {
  const n = markdown.split(bad).length - 1;
  if (n) problems.push(`${bad} × ${n}`);
}
const headings = markdown.split('\n').filter((l) => /^#{1,3} /.test(l));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, markdown, 'utf8');

console.log(`文件：${FILE}`);
console.log(`转换：${raw.length} → ${markdown.length} 字 · 章节标题 ${headings.length} 个`);
console.log(`杂质检查：${problems.length ? problems.join(', ') : '干净 ✓'}`);
console.log(`预览已写出：${OUT}`);
console.log(`\n--- 前 12 行 ---\n${markdown.split('\n').slice(0, 12).join('\n')}`);

if (!SEND) {
  console.log('\n[只读预览] 未投递。确认无误后加 --send 才进入待入库队列。');
  process.exit(0);
}
if (problems.length) {
  console.error('\n检测到杂质，已中止投递。');
  process.exit(1);
}
if (markdown.length > 256 * 1024) {
  console.error('\n超过 256 KiB，已中止。');
  process.exit(1);
}

const before = await api('/api/stage');
const sameTitle = (before.items || []).filter((it) => String(it.title).trim() === title);
if (sameTitle.length) {
  const exact = sameTitle.find((it) => Number(it.chars) === markdown.length);
  if (exact) {
    console.log(`\n队列里已有完全相同的稿（id=${exact.id}），未重复投递。`);
  } else {
    console.log(`\n队列里已有 ${sameTitle.length} 篇同名稿但内容不同（id=${sameTitle[0].id}），未自动覆盖。`);
    console.log('若确认手册已更新、要再投一份，请显式加 --force，或先在界面丢弃旧稿。');
  }
  process.exit(0);
}
const result = await post('/api/stage', {
  title, markdown, notebook: NOTEBOOK, hpath: HPATH,
  note: `来源：${base} · v${VERSION} · push-doc.mjs 推送，待人工确认`,
});
console.log(`\n已投递：id=${result.id} · chars=${result.chars} · hpath=${HPATH}`);
console.log('未调用 commit；请在思源桥「待入库」界面勾选写入。');
