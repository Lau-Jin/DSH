/**
 * 技能检索单测（v3.2）：根发现 / frontmatter / 同名合并 / 文件检索 / 导入 / 清单落盘。
 *
 * 全程在临时目录里造假技能，不碰真实技能根。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const skills = await import(pathToFileURL(path.join(ROOT, 'lib', 'skills.mjs')).href);

let checks = 0;
let failed = 0;
function check(name, ok, extra) {
  checks += 1;
  if (ok) console.log('  PASS ' + name + (extra ? ' | ' + extra : ''));
  else { failed += 1; console.log('  FAIL ' + name + (extra ? ' | ' + extra : '')); }
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'si-skills-'));
const rootA = path.join(work, 'rootA');
const rootB = path.join(work, 'rootB');
fs.mkdirSync(path.join(rootA, 'alpha'), { recursive: true });
fs.mkdirSync(path.join(rootB, 'alpha'), { recursive: true });
fs.mkdirSync(path.join(rootA, 'beta'), { recursive: true });

const skillMd = (name, desc, extra = '') => `---
name: ${name}
version: V2
description: ${desc}
---

# ${name}

正文内容。
${extra}
`;
fs.writeFileSync(path.join(rootA, 'alpha', 'SKILL.md'), skillMd('alpha', '第一个 alpha 技能'));
fs.mkdirSync(path.join(rootA, 'alpha', 'references'), { recursive: true });
fs.writeFileSync(path.join(rootA, 'alpha', 'references', 'x.md'), '# 子文档\n\n这里写了「三层防护」的关键步骤。\n');
fs.writeFileSync(path.join(rootB, 'alpha', 'SKILL.md'), skillMd('alpha', '第二个 alpha 技能'));
fs.writeFileSync(path.join(rootA, 'beta', 'SKILL.md'), skillMd('beta', 'beta 技能'));

const roots = [
  { id: 'test:a', path: rootA, kind: 'test', exists: true },
  { id: 'test:b', path: rootB, kind: 'test', exists: true },
];

try {
  /* ------------------------------------------------------------ 合并 */
  const list = skills.listSkills({ roots });
  check('两个根的技能被合并成一个清单', list.total === 2, `${list.total} 个`);
  check('同名技能合并成一条', list.duplicates === 1, `duplicates=${list.duplicates}`);
  const alpha = list.skills.find((s) => s.name === 'alpha');
  check('同名技能记录了全部来源根', alpha.roots.length === 2, alpha.roots.join(','));
  check('同名技能取优先级最高的根作主副本', alpha.primaryRoot === 'test:a', alpha.primaryRoot);
  check('技能文件清单被统计', alpha.fileCount === 2, `${alpha.fileCount} 个文件`);
  check('frontmatter 被解析（name/version/description）',
    alpha.version === 'V2' && alpha.description === '第一个 alpha 技能', `${alpha.version} / ${alpha.description}`);

  /* ------------------------------------------------------------ 检索 */
  const hit = skills.searchSkills({ query: '三层防护', roots, limit: 10 });
  check('能在子文件里检索到', hit.total >= 1, `${hit.total} 条`);
  const first = hit.hits[0];
  check('命中带文件与行号', Boolean(first && first.file && first.line), first && `${first.file}:${first.line}`);
  check('命中带技能名与片段', Boolean(first && first.skill && first.snippet), first && first.skill);
  const noHit = skills.searchSkills({ query: '绝对不存在的词zzz', roots });
  check('搜不到时给空结果而不是报错', noHit.ok === true && noHit.total === 0);
  check('空 query 被拒', skills.searchSkills({ query: '', roots }).ok === false);

  /* ------------------------------------------------------------ 导入（目录） */
  const target = path.join(work, 'target');
  const imp = await skills.importSkill({ source: path.join(rootA, 'beta'), targetRoot: target });
  check('从目录导入成功', imp.ok === true && imp.imported === 'beta', imp.error || imp.to);
  check('导入后文件真的在目标根里', fs.existsSync(path.join(target, 'beta', 'SKILL.md')));
  const again = await skills.importSkill({ source: path.join(rootA, 'beta'), targetRoot: target });
  check('同名重复导入默认被拒（不覆盖）', again.ok === false && /已存在/.test(again.error || ''), again.error);
  const forced = await skills.importSkill({ source: path.join(rootA, 'beta'), targetRoot: target, overwrite: true });
  check('带 overwrite 才覆盖', forced.ok === true, forced.error || '');

  /* ------------------------------------------------------------ 导入（zip） */
  // 用系统 tar 造一个 zip（Windows 自带 bsdtar）
  const zipSrc = path.join(work, 'pkg');
  fs.mkdirSync(path.join(zipSrc, 'gamma'), { recursive: true });
  fs.writeFileSync(path.join(zipSrc, 'gamma', 'SKILL.md'), skillMd('gamma', '来自 zip 的技能'));
  const zipFile = path.join(work, 'gamma.zip');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  await execFileAsync('tar', ['-a', '-cf', zipFile, '-C', work, 'pkg/gamma'], { timeout: 60000 });
  const impZip = await skills.importSkill({ source: zipFile, targetRoot: target });
  check('从 zip 导入成功（自动找到含 SKILL.md 的那层）', impZip.ok === true && impZip.imported === 'gamma', impZip.error || impZip.to);

  /* ------------------------------------------------------------ 导入的失败分支 */
  const noSkill = path.join(work, 'notaskill');
  fs.mkdirSync(noSkill, { recursive: true });
  fs.writeFileSync(path.join(noSkill, 'readme.txt'), 'x');
  const bad = await skills.importSkill({ source: noSkill, targetRoot: target });
  check('源里没有 SKILL.md 时被拒', bad.ok === false && /SKILL\.md/.test(bad.error || ''), bad.error);
  const missing = await skills.importSkill({ source: path.join(work, 'nope'), targetRoot: target });
  check('路径不存在时给明确错误', missing.ok === false && /不存在/.test(missing.error || ''), missing.error);

  /* ------------------------------------------------------------ 自定义根（环境变量） */
  const customRoot = path.join(work, 'custom');
  fs.mkdirSync(path.join(customRoot, 'gamma2'), { recursive: true });
  fs.writeFileSync(path.join(customRoot, 'gamma2', 'SKILL.md'), skillMd('gamma2', '自定义根里的技能'));
  const prevEnv = process.env.SESSION_INDEX_SKILL_ROOTS;
  process.env.SESSION_INDEX_SKILL_ROOTS = customRoot;
  try {
    const withCustom = skills.listSkills();
    check('环境变量追加的根会被发现',
      withCustom.skills.some((s) => s.name === 'gamma2'),
      withCustom.roots.filter((r) => r.kind === 'custom').map((r) => r.path).join(','));
    check('自定义根的技能也能被检索到',
      skills.searchSkills({ query: '自定义根里的技能', limit: 5 }).total >= 1);
  } finally {
    if (prevEnv === undefined) delete process.env.SESSION_INDEX_SKILL_ROOTS;
    else process.env.SESSION_INDEX_SKILL_ROOTS = prevEnv;
  }

  /* ------------------------------------------------------------ 清单落盘 */
  const idxDir = path.join(work, 'index');
  fs.mkdirSync(idxDir, { recursive: true });
  const cat = skills.writeCatalog(idxDir);
  check('清单写到索引目录', cat.ok === true && fs.existsSync(path.join(idxDir, 'skills.json')), cat.file);
  const read = skills.readCatalog(idxDir);
  check('清单可回读且含技能与根', Array.isArray(read.skills) && Array.isArray(read.roots), `${read.skills?.length} 个技能`);

  /* ------------------------------------------------------------ frontmatter 解析 */
  const fm = skills.parseFrontmatter('---\nname: x\ndescription: "带引号"\nwhenToUse: 描述一\n  续行\n---\n正文');
  check('frontmatter 解析出 name/description', fm.data.name === 'x' && fm.data.description === '带引号', JSON.stringify(fm.data));
  check('frontmatter 续行被接上', /续行/.test(String(fm.data.whenToUse)), String(fm.data.whenToUse));
  check('没有 frontmatter 时 body 就是全文', skills.parseFrontmatter('纯正文').body === '纯正文');
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(`\n==== ${checks - failed}/${checks} session-index skills checks passed ====`);
process.exit(failed === 0 ? 0 : 1);
