#!/usr/bin/env node
/**
 * sync-publish.mjs —— npm 发布副本标准同步工具
 * ------------------------------------------------------------------
 * 作用：把插件源目录的最新代码同步到 dist/publish/<npm包名>/ 发布副本，
 *      自动完成「包名改名 + package.json 发布化改造」，并跑发布前校验。
 *      产物即 npm publish 的直接内容，杜绝手工覆盖破坏改名的事故。
 *
 * 用法：
 *   node sync-publish.mjs <key>          # 同步 + 校验（默认）
 *   node sync-publish.mjs <key> --check  # 只校验现有副本，不同步
 *
 * key ∈ { weekly-report | session-index | siyuan-bridge }
 *
 * 标准流程位置：本目录《插件发布标准流程.md》；路径解析见 paths.mjs
 *   （换机器时写一份 config.local.json，不用改代码）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TOOL_DIR, copyRoot, pluginSrc, pathSummary } from './paths.mjs';

// 副本根目录与源目录都走 paths.mjs 解析（环境变量 > config.local.json > 默认值）
const HERE = TOOL_DIR;

/** 插件注册表：源目录、npm 包名、改名文件清单（相对包根） */
const PLUGINS = {
  'weekly-report': {
    src: pluginSrc('weekly-report', 'D:/WorkBuddy工作区/Tool开发/dsh-weekly-report'),
    npmName: 'dsh-weekly-report-lau',
    oldName: 'dsh-weekly-report',
    // 源目录与 npm 包名不同 → 这些文件里的旧包名要改成 -lau（其它文件用相对路径，无需改名）
    renameFiles: ['package.json', 'plugin.json', 'cordis.patch.yml', 'lib/client.js'],
    // 发布包内禁止出现的敏感内容（包内任意文本文件命中即 FAIL；.cache 拦截由打包清单检查承担）
    sensitive: ['刘晋', '四川传媒学院'],
  },
  'session-index': {
    src: pluginSrc('session-index', 'D:/WorkBuddy工作区/Tool开发/DSH'),
    npmName: 'dsh-session-index-lau',
    oldName: 'dsh-session-index',
    // lib/client.js 必须在列：浏览器半身的模块 id（id / name）要跟着包名走，
    // 否则 npm 装出来的包里客户端模块 id 与包名对不上，侧栏面板可能挂不上。
    // 这里只替换 `dsh-session-index` 这个带前缀的串；命令名 `session-index`
    // （客户端调用、宿主半身注册，两边共用）不含 dsh- 前缀，不会被改，仍然一致。
    renameFiles: ['package.json', 'plugin.json', 'cordis.patch.yml', 'server.mjs',
      'lib/index.mjs', 'lib/pack.mjs', 'lib/client.js', 'check-icon.mjs'],
    sensitive: [],
  },
  'siyuan-bridge': {
    src: pluginSrc('siyuan-bridge', 'D:/WorkBuddy工作区/Tool开发/dsh-siyuan-bridge'),
    npmName: 'dsh-siyuan-bridge',
    oldName: 'dsh-siyuan-bridge',
    renameFiles: [], // 原名发布，无需改名
    sensitive: [],
  },
};

/** 同步时跳过的目录/文件（运行时产物与开发资料，绝不进发布副本） */
const COPY_EXCLUDE = new Set(['node_modules', '.git', '.cache', '.perf-backup', '.workbuddy', 'docs', 'dist', 'pnpm-lock.yaml',
  // 发布工具本身（tools/publish/）：它跟着仓库走版本，但不该进 npm 包
  'publish']);
const TEXT_EXT = /\.(js|mjs|cjs|json|ya?ml|md|html|txt|sh|vbs|cmd|command|svg)$/i;

function fail(msg) { console.error(`\n✗ FAIL ${msg}`); process.exit(1); }
function ok(msg) { console.log(`✓ ${msg}`); }

function walk(dir, base = '', out = [], excludes = COPY_EXCLUDE) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (!excludes.has(name)) walk(full, rel, out, excludes);
    } else if (!excludes.has(name)) out.push({ full, rel });
  }
  return out;
}

/** 副本残留清理用的遍历：除 node_modules / .git 外一律进入，
 *  这样才能删掉源目录已删除的 docs/、dist/ 等被 COPY_EXCLUDE 排除的目录内容。 */
const CLEAN_EXCLUDE = new Set(['node_modules', '.git']);
/** 副本清理时要保留的 bundled 依赖目录（npm 打包需要实体存在） */

/** 删除副本里已清空的目录（含 COPY_EXCLUDE 目录），只删空目录，保留 git 元数据。 */
function pruneEmptyDirs(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (CLEAN_EXCLUDE.has(name)) continue;
    const full = path.join(dir, name);
    if (!fs.statSync(full).isDirectory()) continue;
    pruneEmptyDirs(full);
    if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
  }
}

/** package.json 发布化改造：去 private、补 engines.dsh、补 publishConfig */
function patchPackageJson(pkgPath, npmName) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  delete pkg.private;
  pkg.name = npmName;
  pkg.engines = { ...(pkg.engines || {}), node: pkg.engines?.node || '>=20', dsh: '>=0.2.1-rc.3 <0.3.0' };
  pkg.publishConfig = { access: 'public', registry: 'https://registry.npmjs.org/' };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}

/** npm pack --json 的返回形态随版本变：旧版是数组，npm 11+ 是 {包名: {...}} —— 两种都认 */
function packEntry(raw) {
  const parsed = JSON.parse(raw);
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  if (!entry || !Array.isArray(entry.files)) {
    throw new Error(`npm pack --json 返回形态不认识：${String(raw).slice(0, 200)}`);
  }
  return entry;
}

function main() {
  const [, , keyArg, ...rest] = process.argv;
  const checkOnly = rest.includes('--check');
  const cfg = PLUGINS[keyArg];
  if (!cfg) fail(`未知插件 key：${keyArg}（可选：${Object.keys(PLUGINS).join(' | ')}）`);
  const src = path.resolve(cfg.src);
  const dst = path.join(copyRoot(), cfg.npmName);
  // 要随包打进 npm 的依赖（bundledDependencies）：声明放顶层，
  // 拷贝循环与打包清单校验两处都要用（嵌套块里声明会漏作用域）
  const bundled = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dst, 'package.json'), 'utf8')).bundledDependencies || [];
    } catch { return []; }
  })();

  if (!fs.existsSync(src)) fail(`源目录不存在：${src}`);
  const srcPkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
  // 源目录保留 private:true 是刻意设计（防止在源目录误 publish）；发布化改造只发生在副本上
  const version = srcPkg.version;
  // 零依赖插件（session-index 只有 peer，peer 由宿主提供、本来就不打包）没有 node_modules，
  // 下面「必须带出依赖树」的两处断言只对真正声明了 dependencies 的插件生效。
  const hasDeps = Boolean(srcPkg.dependencies && Object.keys(srcPkg.dependencies).length);

  if (!checkOnly) {
    // ---- 同步 ----
    if (!fs.existsSync(dst)) fail(`发布副本不存在：${dst}（首次发布请手工创建）`);
    const files = walk(src);
    let copied = 0;
    for (const f of files) {
      const target = path.join(dst, f.rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(f.full, target);
      copied++;
    }
    // 删除副本里源目录已不存在的文件（防残留旧文件进包）
    // bundledDependencies：把源目录里已装好的依赖带进副本（COPY_EXCLUDE 排除了 node_modules，
  // 但 npm 打包要求依赖实体存在，否则 tarball 里没有它、装完就缺绩效表组件）
  // 只拷依赖本体不够：exceljs 的依赖（jszip/archiver/…）平铺在源目录顶层，
  // npm 打包不会顺带兄弟目录 —— 1.3.4 就是这么缺了 jszip。
  // 按「包名闭包」算也不行：源树里有**嵌套的同名不同版本**（lazystream 下的老
  // readable-stream 还要 process-nextick-args，顶层那版没有这个依赖），按名字解析会漏。
  // 所以整棵树照搬：源 node_modules 里每个「带 package.json 的目录」都拷进去，
  // 嵌套副本随父包一起走，Node 的向上解析与源目录完全一致。
  const BUNDLE_DENY = new Set(['@deepseek-ai']);   // peer 由宿主提供，不打包
  {
    const srcMods = path.join(src, 'node_modules');
    const dstMods = path.join(dst, 'node_modules');
    let copiedPkgs = 0;
    let copiedBytes = 0;
    const entries = fs.existsSync(srcMods) ? fs.readdirSync(srcMods) : [];
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;                 // .bin / .package-lock.json / .modules.yaml
      if (BUNDLE_DENY.has(entry)) continue;
      const s = path.join(srcMods, entry);
      let st = null;
      try { st = fs.statSync(s); } catch { continue; }
      if (!st.isDirectory()) continue;
      const d = path.join(dstMods, entry);
      fs.rmSync(d, { recursive: true, force: true });
      fs.cpSync(s, d, { recursive: true });
      copiedPkgs += 1;
      try { copiedBytes += fs.statSync(d).size; } catch { /* ignore */ }
    }
    if (!copiedPkgs && hasDeps) fail('源目录 node_modules 里没拷到任何包（先在源目录 npm i exceljs）');
    if (copiedPkgs) ok(`bundled 依赖整树带入副本：${copiedPkgs} 个顶层包（含嵌套副本，peer @deepseek-ai 不打包）`);
    else ok('源目录没有运行时依赖（零依赖插件），无需带依赖树');
  }

  // 用 CLEAN_EXCLUDE 遍历，确保 docs/、dist/ 等被 COPY_EXCLUDE 排除的目录残留也能清掉
    const srcRel = new Set(files.map((f) => f.rel));
    for (const f of walk(dst, '', [], CLEAN_EXCLUDE)) {
      if (!srcRel.has(f.rel)) { fs.rmSync(f.full); console.log(`  - 移除源目录已不存在：${f.rel}`); }
    }
    pruneEmptyDirs(dst);
    ok(`已同步 ${copied} 个文件 → ${dst}`);

    // ---- 改名（源包名 ≠ npm 包名时）----
    if (cfg.npmName !== cfg.oldName) {
      for (const rel of cfg.renameFiles) {
        const p = path.join(dst, rel);
        if (!fs.existsSync(p)) { console.log(`  ! 改名文件缺失（跳过）：${rel}`); continue; }
        let text = fs.readFileSync(p, 'utf8');
        if (!text.includes(cfg.oldName)) { console.log(`  ! ${rel} 未找到旧包名（确认是否结构变化）`); continue; }
        text = text.split(cfg.npmName).join('\u0000').split(cfg.oldName).join(cfg.npmName).split('\u0000').join(cfg.npmName);
        fs.writeFileSync(p, text, 'utf8');
        ok(`改名 ${rel}：${cfg.oldName} → ${cfg.npmName}`);
      }
    }
    // ---- package.json 发布化 ----
    patchPackageJson(path.join(dst, 'package.json'), cfg.npmName);
    ok(`package.json 发布化（name=${cfg.npmName}、无 private、engines.dsh、publishConfig）`);
  }

  // ---- 校验（同步与 --check 都会跑）----
  console.log(`\n—— 发布前校验（${cfg.npmName}@${version}）——`);
  const pkg = JSON.parse(fs.readFileSync(path.join(dst, 'package.json'), 'utf8'));
  if (pkg.version !== version) fail(`副本版本 ${pkg.version} ≠ 源版本 ${version}`);
  if (pkg.private) fail('副本 package.json 仍有 private:true');
  if (pkg.name !== cfg.npmName) fail(`副本包名 ${pkg.name} ≠ ${cfg.npmName}`);

  // cordis.patch.yml 挂载名必须等于包名（DSH 加载校验的硬要求）
  const patchText = fs.readFileSync(path.join(dst, 'cordis.patch.yml'), 'utf8');
  const m = patchText.match(/name:\s*['"]([^'"]+)['"]/);
  if (!m || m[1] !== cfg.npmName) fail(`cordis.patch.yml 挂载名 ${m ? m[1] : '(未找到)'} ≠ 包名 ${cfg.npmName}`);
  ok(`bundle 挂载名一致：${cfg.npmName}`);

  // 源目录改名核对：改名文件里的包名必须已全部替换（-lau 新名包含旧名前缀，需先剔除新名再查）
  if (cfg.npmName !== cfg.oldName) {
    const bad = cfg.renameFiles.filter((rel) => {
      const p = path.join(dst, rel);
      try { return fs.readFileSync(p, 'utf8').split(cfg.npmName).join('').includes(cfg.oldName); } catch { return false; }
    });
    if (bad.length) fail(`改名不彻底，仍含旧包名 ${cfg.oldName}：${bad.join('、')}`);
    ok(`改名文件旧包名残留 0 处`);
  }

  // npm pack 实际打包清单：拦截 .cache / 运行时配置 / node_modules
  console.log('  npm pack --dry-run …');
  const packOut = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: dst, encoding: 'utf8', shell: true });
  const packList = packEntry(packOut).files.map((f) => f.path);
  // 整树打包后 node_modules 里是「exceljs + 它的整棵依赖树」，
  // 这里只拦：运行时配置、缓存目录、以及 peer（必须由宿主提供，不能打进包）
  const forbidden = packList.filter((p) => (/service\/config\.json$/.test(p)
    || /(^|\/)(\.cache|\.perf-backup)(\/|$)/.test(p)
    || p.startsWith('node_modules/@deepseek-ai/')));
  if (forbidden.length) fail(`打包清单含敏感文件：\n  ${forbidden.join('\n  ')}`);
  const bundledCount = packList.filter((p) => p.startsWith('node_modules/')).length;
  if (!bundledCount && hasDeps) fail('打包清单里一个 node_modules 文件都没有 —— bundled 依赖没带上');
  ok(`打包清单干净：${packList.length} 个文件（含依赖树 ${bundledCount} 个），无 .cache / config.json / peer`);

  // 敏感内容扫描（仅扫文本文件）
  let hits = [];
  for (const f of walk(dst, '', [], CLEAN_EXCLUDE)) {
    if (!TEXT_EXT.test(f.rel)) continue;
    const text = fs.readFileSync(f.full, 'utf8');
    for (const s of cfg.sensitive) if (text.includes(s)) hits.push(`${f.rel} ← "${s}"`);
  }
  if (hits.length) fail(`敏感内容命中 ${hits.length} 处：\n  ${hits.join('\n  ')}`);
  ok(`敏感内容扫描通过${cfg.sensitive.length ? `（${cfg.sensitive.length} 项规则）` : ''}`);

  // registry 版本核对（防止重复版本发布失败）
  try {
    const reg = execFileSync('npm', ['view', cfg.npmName, 'version'], { encoding: 'utf8', shell: true }).trim();
    console.log(`  registry 当前版本：${reg} → 本次发布 ${version}${reg === version ? '（⚠ 同版本会被拒，先升版本号）' : ''}`);
  } catch { console.log('  registry 尚无此包（首刷发布）'); }

  const size = packEntry(packOut).size;
  console.log(`\n✅ ${cfg.npmName}@${version} 发布副本就绪（${packList.length} 文件 / ${(size / 1024).toFixed(0)} KB）`);
  console.log(`   发布：cd "${dst}" && npm publish --access public`);
  console.log(`   更新安装（DSH profile 目录）：npx -y pnpm@11.28.5 update ${cfg.npmName}`);
}

main();
