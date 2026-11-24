#!/usr/bin/env node
/**
 * 发布核验门禁 —— 标准流程第 ④.5 步（发布前）与第 ⑧ 步（安装后）
 *
 *   node check-release.mjs session-index --pre         发布前：代码/测试/版本/副本/registry
 *   node check-release.mjs session-index --post        安装后：四处版本与行为统一 + MCP 握手
 *   node check-release.mjs siyuan-bridge --pre         发布前（面板类：无 MCP 握手）
 *   node check-release.mjs siyuan-bridge --post        安装后（面板类）
 *   node check-release.mjs <key> --pre --fast          跳过 smoke（仅调试，不可作为放行依据）
 *
 * 任一 FAIL 即退出码 1。**核验未通过禁止推进标准流程。**
 *
 * flavor:
 *   mcp   —— 会话索引：额外做「批量推送只读预览 / 持久化判重标志 / MCP 14 工具握手 /
 *            server-path.txt 指向 / 发布副本含 push-doc 脚本」等专属检查
 *   panel —— 面板类（思源桥）：做通用检查 + 运行时文件齐全 + bundle 挂载名，不做 MCP 握手
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { TOOL_DIR: HERE, copyRoot, pluginSrc, profileDir } = await import('./paths.mjs');
const argv = process.argv.slice(2);
const key = argv.find((a) => !a.startsWith('--')) || '';
const POST = argv.includes('--post');
const FAST = argv.includes('--fast');

const PROFILE = profileDir();

/** 各插件的门禁配置。新增插件只需在此登记一份。 */
const CFG = {
  'session-index': {
    src: pluginSrc('session-index', 'D:/WorkBuddy工作区/Tool开发/DSH'),
    copy: path.join(copyRoot(), 'dsh-session-index-lau'),
    npmName: 'dsh-session-index-lau',
    profile: PROFILE,
    pkgDir: 'dsh-session-index-lau',
    flavor: 'mcp',
    // 源仓库版本声明一致：读取文件 → 必须包含的串
    // 注意 smoke.mjs 从 v2.6.0 起改成「跟 package.json 对齐、只改一处」，
    // 不再硬编码版本号，所以这里断言的是那行取值代码本身（否则发版必挂）。
    versionMarkers: (v) => ({
      'plugin.json': `"version": "${v}"`,
      'server.mjs': `const VERSION = '${v}'`,
      'smoke.mjs': 'const wantVer = pkgStd.version',
      'README.md': `**v${v}**`,
      '操作使用手册.html': `v${v}`,
    }),
    // 全量语法检查清单（相对源目录）；lib/*.mjs 自动追加
    syntaxFiles: ['server.mjs', 'build-index.mjs', 'pack.mjs', 'smoke.mjs', 'check-icon.mjs', 'tools/push-doc.mjs'],
    smokeRe: /结果：(\d+)\/\1 通过/,
    // POST 运行时文件清单
    runtimeFiles: ['server.mjs', 'lib/stage.mjs', 'lib/index.mjs', 'cordis.patch.yml', 'icon.svg'],
  },
  'weekly-report': {
    src: pluginSrc('weekly-report', 'D:/WorkBuddy工作区/Tool开发/dsh-weekly-report'),
    gitRoot: 'D:/Lau-tool-public', // 源目录不是 git 仓库，公库本地常驻在此
    copy: path.join(copyRoot(), 'dsh-weekly-report-lau'),
    npmName: 'dsh-weekly-report-lau',
    profile: PROFILE,
    pkgDir: 'dsh-weekly-report-lau',
    flavor: 'panel',
    versionMarkers: (v) => ({
      'plugin.json': `"version": "${v}"`,
      'README.md': `v${v}`,
      '操作使用手册.html': `v${v}`,
      'service/public/index.html': `?v=${v}`,
    }),
    syntaxFiles: [
      'smoke.mjs', 'lib/index.js', 'lib/client.js', 'service/server.cjs',
      'service/engine/gen-weekly.mjs', 'service/engine/repair-report.mjs',
      ...['collect', 'config', 'fetch', 'mcp', 'notify', 'perf-map', 'perf',
        'period', 'render', 'rules', 'util', 'xlsx'].map((n) => `service/engine/lib/${n}.mjs`),
      'service/engine/lib/rules.mjs',
    ],
    smokeRe: /结果：(\d+)\/\1 通过/,
    runtimeFiles: [
      'lib/index.js', 'lib/client.js', 'service/server.cjs', 'service/public/index.html',
      'service/public/app.js', 'service/engine/gen-weekly.mjs', 'service/engine/lib/rules.mjs',
      'cordis.patch.yml', 'icon.svg', 'smoke.mjs',
    ],
  },
  'siyuan-bridge': {
    src: pluginSrc('siyuan-bridge', 'D:/WorkBuddy工作区/Tool开发/dsh-siyuan-bridge'),
    copy: path.join(copyRoot(), 'dsh-siyuan-bridge'),
    npmName: 'dsh-siyuan-bridge',
    profile: PROFILE,
    pkgDir: 'dsh-siyuan-bridge',
    flavor: 'panel',
    versionMarkers: (v) => ({
      'plugin.json': `"version": "${v}"`,
      'lib/index.js': `const VERSION = '${v}'`,
      'README.md': `v${v}`,
      '操作使用手册.html': `v${v}`,
    }),
    syntaxFiles: [
      'lib/index.js', 'lib/client.js', 'setup.mjs', 'smoke.mjs',
      'service/server.mjs', 'service/bridge-cli.mjs', 'service/save-doc.mjs',
      'service/html-repair.mjs', 'service/lib/markdown.mjs', 'service/plugin/index.js', 'service/public/app.js',
      'tools/verify-lifecycle.mjs', 'tools/audit-render.mjs', 'tools/inspect-doc.mjs',
      'tools/fix-sql-blocks.mjs', 'tools/import-manual.mjs', 'tools/import-win-doc.mjs',
    ],
    smokeRe: /(\d+)\/\1 通过 · 全部通过/,
    runtimeFiles: [
      'lib/index.js', 'lib/client.js', 'service/server.mjs', 'service/lib/markdown.mjs',
      'service/public/index.html',
      'service/public/app.js', 'cordis.patch.yml', 'icon.svg', 'setup.mjs', 'smoke.mjs',
    ],
  },
};

const c = CFG[key];
if (!c) {
  console.error(`未知 key：${key}（可用：${Object.keys(CFG).join(' | ')}）`);
  process.exit(1);
}
const ver = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')).version; } catch { return null; } };
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, {
  encoding: 'utf8', shell: true, timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'],
  cwd: c.src, ...opts,
});
const nodeBin = process.execPath;

console.log(`=== ${key} 发布核验（${POST ? 'POST 安装后' : 'PRE 发布前'} · ${c.flavor}）===`);
const srcVer = ver(path.join(c.src, 'package.json'));
const copyVer = ver(path.join(c.copy, 'package.json'));
const installedVer = ver(path.join(c.profile, 'node_modules', c.pkgDir, 'package.json'));
console.log(`源 ${srcVer} · 副本 ${copyVer} · 已装 ${installedVer}\n`);

// ---------------------------------------------------------------- 共用：版本声明一致性
check('源仓库版本声明一致', (() => {
  const markers = c.versionMarkers(srcVer);
  const bad = [];
  for (const [file, needle] of Object.entries(markers)) {
    let text = '';
    try { text = fs.readFileSync(path.join(c.src, file), 'utf8'); } catch { /* ignore */ }
    if (!text.includes(needle)) bad.push(file);
  }
  if (bad.length) console.log(`       缺版本声明：${bad.join('、')}`);
  return bad.length === 0;
})(), `v${srcVer}`);

// ---------------------------------------------------------------- PRE
if (!POST) {
  check('源目录 git 工作区干净', (() => {
    try { return run('git', ['status', '--porcelain'], { cwd: c.gitRoot || c.src }).trim() === ''; } catch { return false; }
  })(), '不允许发布未提交改动');

  check('全量语法检查通过', (() => {
    try {
      const files = [...new Set(c.syntaxFiles)];
      if (c.flavor === 'mcp') {
        files.push(...fs.readdirSync(path.join(c.src, 'lib'))
          .filter((f) => f.endsWith('.mjs')).map((f) => 'lib/' + f));
      }
      for (const f of files) execFileSync(nodeBin, ['--check', f], { cwd: c.src, stdio: 'ignore' });
      return true;
    } catch (e) { console.log(`       语法失败：${String(e.message).slice(0, 120)}`); return false; }
  })());

  if (FAST) {
    console.log('SKIP  冒烟测试（--fast，不可作为放行依据）');
  } else {
    let out = '';
    let ok = false;
    try { out = run(nodeBin, ['smoke.mjs']); ok = c.smokeRe.test(out); } catch (e) { out = String(e.stdout || e.message); }
    check('端到端冒烟全部通过', ok, (out.match(/[^\n]*通过[^\n]*/) || [''])[0].trim());
  }

  // ---- 会话索引专属（mcp flavor）----
  if (c.flavor === 'mcp') {
    check('批量推送脚本可运行（只读预览）', (() => {
      try {
        const out = run(nodeBin, ['tools/push-doc.mjs', '--from-workbuddy']);
        return out.includes('唯一可推送') && out.includes('只读预览');
      } catch { return false; }
    })());

    check('新流程标志：持久化判重状态已启用', (() => {
      const s = fs.readFileSync(path.join(c.src, 'tools/push-doc.mjs'), 'utf8');
      return s.includes('push-doc-state.json') && s.includes('--seed') && s.includes('已推送过（丢弃也不重推）');
    })(), 'push-doc-state.json / --seed / 丢弃不重推');
  }

  let synced = '';
  try { synced = run(nodeBin, [path.join(HERE, 'sync-publish.mjs'), `${key}`, '--check']); } catch (e) { synced = String(e.stdout || e.message); }
  check('发布副本同步且自检通过', synced.includes('发布副本就绪'), (synced.match(/✅[^\n]*/) || [''])[0]);
  check('发布副本版本 = 源版本', copyVer === srcVer, `副本 ${copyVer}`);

  check('发布副本无 legacy 安装器残留', (() => {
    const legacy = ['install.mjs', 'install.sh', 'install.cmd', 'update.cmd', 'update.sh',
      '一键安装.vbs', '一键安装.cmd', '一键安装.command', 'docs'];
    const stray = legacy.filter((f) => fs.existsSync(path.join(c.copy, f)));
    if (stray.length) console.log(`       残留：${stray.join('、')}`);
    return stray.length === 0;
  })(), '纯 npm 包形态');

  if (c.flavor === 'mcp') {
    check('发布副本含新流程脚本', (() => {
      const p = path.join(c.copy, 'tools/push-doc.mjs');
      return fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('push-doc-state.json');
    })());
  }

  let regVer = '';
  try { regVer = run('npm', ['view', c.npmName, 'version', '--prefer-online']).trim(); } catch { /* ignore */ }
  check('registry 上该版本尚未发布', regVer !== srcVer, `registry ${regVer} / 本次 ${srcVer}`);
  check('版本跳幅符合语义化规则', (() => {
    // 规则：一次发布只在一位上 +1 —— 小改动 PATCH、大改动 MINOR、不兼容 MAJOR；
    // 其余位必须不动、且新版本严格大于上一个已发布版本。连跳/降版/重复一律不放行。
    if (!regVer) return true;                       // registry 读不到时不误判
    const a = regVer.split('.').map(Number);
    const b = srcVer.split('.').map(Number);
    if (a.length !== 3 || b.length !== 3 || [...a, ...b].some((x) => !Number.isFinite(x))) return false;
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const isMajor = d[0] === 1 && d[1] === -a[1] && d[2] === -a[2];
    const isMinor = d[0] === 0 && d[1] === 1 && d[2] === -a[2];
    const isPatch = d[0] === 0 && d[1] === 0 && d[2] === 1;
    return isMajor || isMinor || isPatch;
  })(), `上一个 ${regVer || '(未知)'} → 本次 ${srcVer}（只允许 +0.0.1 / +0.1.0 / +1.0.0）`);
}

// ---------------------------------------------------------------- POST
if (POST) {
  let regVer = '';
  try { regVer = run('npm', ['view', c.npmName, 'version', '--prefer-online']).trim(); } catch { /* ignore */ }
  check('npm latest = 源版本', regVer === srcVer, `latest ${regVer} / 源 ${srcVer}`);
  check('发布副本版本 = 源版本', copyVer === srcVer, `副本 ${copyVer}`);
  check('DSH 已装版本 = 源版本', installedVer === srcVer, `已装 ${installedVer}`);

  const installed = path.join(c.profile, 'node_modules', c.pkgDir);
  for (const [label, dir] of [['发布副本', c.copy], ['DSH 已装', installed]]) {
    if (c.flavor === 'mcp') {
      check(`${label} 的批量脚本与源行为一致`, (() => {
        const p = path.join(dir, 'tools/push-doc.mjs');
        if (!fs.existsSync(p)) return false;
        const srcFile = fs.readFileSync(path.join(c.src, 'tools/push-doc.mjs'), 'utf8');
        const dstFile = fs.readFileSync(p, 'utf8');
        // 副本做过包名改名，只比关键机制标志与文件规模，避免误报
        return dstFile.includes('push-doc-state.json') && dstFile.includes('--seed')
          && Math.abs(dstFile.length - srcFile.length) < 200;
      })(), 'tools/push-doc.mjs');
    }
    check(`${label} 的运行时文件齐全`, (() => {
      const missing = c.runtimeFiles.filter((f) => !fs.existsSync(path.join(dir, f)));
      if (missing.length) console.log(`       缺文件：${missing.join('、')}`);
      return missing.length === 0;
    })(), `${c.runtimeFiles.length} 项`);
  }

  check('bundle 挂载名 = npm 包名', (() => {
    try { return fs.readFileSync(path.join(installed, 'cordis.patch.yml'), 'utf8').includes(`name: '${c.npmName}'`); } catch { return false; }
  })(), c.npmName);

  // ---- 会话索引专属 ----
  if (c.flavor === 'mcp') {
    check('server-path.txt 指向已装包', (() => {
      try {
        const p = fs.readFileSync(path.join(process.env.USERPROFILE || 'C:/Users/Administrator', '.dsh/session-index/server-path.txt'), 'utf8').trim();
        return p.includes(c.pkgDir) && fs.existsSync(p);
      } catch { return false; }
    })());

    // 直接启动已装包做 MCP 握手
    const handshake = await new Promise((resolve) => {
      const child = spawn(nodeBin, [path.join(installed, 'server.mjs')], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, SESSION_INDEX_AUTO_INTERVAL_MS: '3600000', SESSION_INDEX_WATCH_DEBOUNCE_MS: '60000' },
      });
      let buf = ''; let id = 1; const pending = new Map();
      child.stderr.on('data', () => {});
      child.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        }
      });
      const req = (method, params = {}) => new Promise((res) => {
        const n = id++; const t = setTimeout(() => res(null), 15000);
        pending.set(n, (m) => { clearTimeout(t); res(m); });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
      });
      (async () => {
        try {
          const init = await req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'release-check', version: '1' } });
          const tools = (await req('tools/list'))?.result?.tools || [];
          const st = await req('tools/call', { name: 'session_index_stage', arguments: { status: true } });
          const payload = JSON.parse(st?.result?.content?.[0]?.text || '{}');
          resolve({ version: init?.result?.serverInfo?.version, count: tools.length, hasStage: tools.some((t) => t.name === 'session_index_stage'), bridge: payload.ok === true });
        } catch (e) { resolve({ error: e.message }); }
        finally { child.stdin.end(); child.kill(); }
      })();
    });
    // 工具数从 plugin.json 读（单一事实来源）：以前写死 14，加工具就要改门禁，
  // 和 smoke 里写死版本号是同一种毛病。
  const expectedTools = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(c.src, 'plugin.json'), 'utf8'))?.mcp?.toolCount ?? 0; } catch { return 0; }
  })();
  check('已装包 MCP 握手与工具清单', handshake.version === srcVer && handshake.count === expectedTools && handshake.hasStage,
      `v${handshake.version} / ${handshake.count} 工具 / stage=${handshake.hasStage}`);
    check('已装包可探测思源桥', handshake.bridge === true);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('未通过：' + failed.map((r) => r.name).join('；'));
  console.log(POST ? '✗ 安装后核验未通过，禁止宣告发布完成。' : '✗ 发布前核验未通过，禁止推进标准流程。');
  process.exit(1);
}
console.log(POST ? '✅ 版本与行为四处统一，可以交付。' : '✅ 核验通过，可以按标准流程推进发布。');
