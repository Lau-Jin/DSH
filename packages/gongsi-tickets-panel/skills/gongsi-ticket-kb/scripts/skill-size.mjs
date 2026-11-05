#!/usr/bin/env node
/**
 * 技能体积自检 —— 防止 SKILL.md 悄悄膨胀回去。
 *
 * 用法：node scripts/skill-size.mjs
 * 退出码：0 = 全部在预算内；1 = 有超标项。
 *
 * ⚠️ 预算按**字符数**算，不是字节数。中文 UTF-8 是 3 字节/字，但 token 成本跟字符走。
 *    按字节算会把正常体积误报成超标。
 *
 * 预算：
 *   SKILL.md            ≤ 9000 字符   —— 每次加载都全量注入，最贵
 *   单个 reference      ≤ 12000 字符  —— 按需读，读一次就是一次往返
 *   references 合计     ≤ 30000 字符
 *   scripts 不计入      —— 代码不进上下文，只在执行时消耗
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET = {
  skill: 9000,
  reference: 12000,
  refsTotal: 30000,
};

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const rows = [];
let skillChars = 0;
let refChars = 0;
let scriptChars = 0;

for (const f of walk(ROOT)) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const text = fs.readFileSync(f, 'utf8');
  const chars = [...text].length;
  const isSkill = rel === 'SKILL.md';
  const isRef = rel.startsWith('references/') && rel.endsWith('.md');
  const isScript = rel.startsWith('scripts/');
  if (isSkill) skillChars += chars;
  else if (isRef) refChars += chars;
  else if (isScript) scriptChars += chars;
  const limit = isSkill ? BUDGET.skill : isRef ? BUDGET.reference : null;
  const over = limit !== null && chars > limit;
  rows.push({
    文件: rel,
    类型: isSkill ? '核心(每次注入)' : isRef ? 'reference(按需)' : isScript ? 'script(不注入)' : '其它',
    字符: chars,
    行: text.split('\n').length,
    状态: over ? '✗ 超标' : limit !== null ? '✓' : '—',
  });
}

console.log('文件'.padEnd(38) + '类型'.padEnd(20) + '字符'.padStart(7) + '行'.padStart(6) + '  状态');
console.log('-'.repeat(82));
for (const r of rows) {
  console.log(r.文件.padEnd(38) + r.类型.padEnd(20) + String(r.字符).padStart(7) + String(r.行).padStart(6) + '  ' + r.状态);
}
console.log('-'.repeat(82));
console.log(`核心 ${skillChars} / ${BUDGET.skill} 字符   references 合计 ${refChars} / ${BUDGET.refsTotal}   scripts ${scriptChars}（不计入预算）`);

const problems = [];
if (skillChars > BUDGET.skill) problems.push(`SKILL.md 超标（${skillChars} > ${BUDGET.skill}）：每次加载都全量注入，最贵`);
if (refChars > BUDGET.refsTotal) problems.push(`references 合计超标（${refChars} > ${BUDGET.refsTotal}）：考虑把某块提升为独立技能，用 description 精确路由`);
for (const r of rows) {
  if (r.状态 === '✗ 超标') problems.push(`${r.文件} 超标：这段能不能①变成脚本 ②属于产品事实(→KB) ③只在某类工单才用(→独立技能)？`);
}

if (problems.length) {
  console.log('');
  console.log('--- 超标，先别急着加内容，按这个顺序处理 ---');
  for (const x of problems) console.log(`· ${x}`);
  process.exit(1);
}
console.log('全部在预算内。');
