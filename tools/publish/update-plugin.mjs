#!/usr/bin/env node
/**
 * update-plugin.mjs —— DSH 插件安装更新工具（标准流程第⑦步）
 * ------------------------------------------------------------------
 * 解决的问题：周报面板服务由心跳拉起时 cwd 在 node_modules/<包>/service/ 内，
 *   Windows 下进程会锁住目录树，pnpm update 重命名目录报 ERR_PNPM_EPERM；
 *   而杀掉面板后心跳 20s 内又会拉起新进程，pnpm 抢不过这个窗口。
 *
 * 原理：心跳 reachable() 探活成功就不会 spawn。本工具：
 *   1. 在面板端口起一个「占位应答器」（对任意请求回 200）
 *   2. 杀掉真面板 → 心跳探活命中占位器 → 不再拉起 → 目录解锁
 *   3. pnpm update 从 registry 更新（清掉 tmp/.ignored 残留）
 *   4. 校验安装结果 → 撤掉占位器 → 心跳自动从新版拉起面板 → 验证版本
 *
 * 用法：node update-plugin.mjs <key> [--pkg <npm包名>] [--version <期望版本>] [--port <心跳端口>]
 *   key ∈ { weekly-report | session-index | siyuan-bridge }；也可 --pkg 直接指定包名
 *
 * 心跳端口默认 8798（周报面板）。思源桥服务在 5599、探活 /api/status，
 * 更新时需 `--port 5599`；占位应答器对任意请求回 200，满足两种探活。
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { profileDir } = await import('./paths.mjs');
const PROFILE = profileDir();
const KEY2PKG = {
  'weekly-report': 'dsh-weekly-report-lau',
  'session-index': 'dsh-session-index-lau',
  'siyuan-bridge': 'dsh-siyuan-bridge',
};

function log(msg) { console.log(msg); }
function fail(msg) { console.error(`\n✗ FAIL ${msg}`); process.exit(1); }

const argv = process.argv.slice(2);
const keyIdx = argv.findIndex((a) => !a.startsWith('--'));
const key = keyIdx >= 0 ? argv[keyIdx] : '';
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const pkg = opt('--pkg') || KEY2PKG[key];
if (!pkg) fail(`缺少插件 key（可选：${Object.keys(KEY2PKG).join(' | ')}，或 --pkg <包名>）`);
// 心跳探活端口：默认 8798（周报），思源桥用 --port 5599
const HEARTBEAT_PORT = Number(opt('--port') || (key === 'siyuan-bridge' ? 5599 : 8798));
// 探活路径：周报 /api/state，思源桥 /api/status（占位器对任意路径回 200，两者皆可）
const PROBE_PATH = opt('--probe') || (key === 'siyuan-bridge' ? '/api/status' : '/api/state');
const WORKSPACE_YAML = path.join(PROFILE, 'pnpm-workspace.yaml');

/** 查询 registry 最新版（绕过本地缓存） */
function registryLatest() {
  return new Promise((resolve) => {
    http.get(`http://registry.npmjs.org/${pkg}`, { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)['dist-tags'].latest); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

/** pnpm 供应链冷却期豁免：minimumReleaseAgeExclude 按精确版本钉死，
 *  新版本不在名单会被 pnpm 拒装而静默回退旧版——发布后必须登记新版本 */
function pinReleaseExclude(version) {
  if (!fs.existsSync(WORKSPACE_YAML)) return;
  const text = fs.readFileSync(WORKSPACE_YAML, 'utf8');
  const pin = `${pkg}@${version}`;
  if (text.includes(pin)) return;
  const re = new RegExp(`(  - )${pkg}@[^\\n]*`);
  const updated = re.test(text)
    ? text.replace(re, `$1${pin}`) // 已有旧版本钉 → 升级钉
    : text.replace(/\n?$/, `\n`) + `  - ${pin}\n`; // 无钉 → 追加
  fs.writeFileSync(WORKSPACE_YAML, updated, 'utf8');
  log(`   ✓ 已登记供应链豁免：${pin}`);
}

/** 端口探活：返回 { body, ok }；连不上返回 null */
function probe() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${HEARTBEAT_PORT}${PROBE_PATH}`, { timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ body: body.slice(0, 200), ok: res.statusCode < 400 }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** 找到并杀掉占用面板端口的进程（返回被杀 pid） */
function killPanel() {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', shell: true });
    const pid = out.split('\n')
      .find((l) => l.includes(`:${HEARTBEAT_PORT}`) && l.includes('LISTENING'))
      ?.trim().split(/\s+/).pop();
    if (pid && pid !== '0') {
      execFileSync('taskkill', ['/PID', pid, '/F'], { shell: true }).catch?.(() => {});
      return pid;
    }
  } catch { /* 端口空闲 */ }
  return null;
}

/** 起占位应答器：任意请求回 200，让心跳认为面板在线 */
function startPlaceholder() {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => { res.writeHead(200); res.end('placeholder'); });
    const tryBind = (n) => {
      srv.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && n < 300) setTimeout(() => tryBind(n + 1), 400);
        else fail(`占位应答器无法绑定端口 ${HEARTBEAT_PORT}：${e.code}`);
      });
      srv.listen(HEARTBEAT_PORT, '127.0.0.1', () => resolve(srv));
      // note: listen 重复调用在已 error 的实例上需重新监听——每次失败换新实例
    };
    tryBind(0);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const expectVersion = opt('--version') || (await registryLatest());
  log(`—— 更新 ${pkg}（profile: ${PROFILE}，目标版本：${expectVersion || '最新'}）——`);

  // 1. 起占位器 + 杀真面板，直到占位器接管端口（最多 15 轮，对抗心跳复活竞态）
  const holder = startPlaceholder();
  log('1. 起占位应答器并接管面板端口 …');
  let rounds = 0;
  while (rounds++ < 15) {
    const r = await probe();
    if (r && r.body.startsWith('placeholder')) break;
    const killed = killPanel();
    if (killed) log(`   轮次 ${rounds}：杀面板 pid=${killed}`);
    await sleep(700);
  }
  const r = await probe();
  if (!r || !r.body.startsWith('placeholder')) fail('占位器未能接管端口（心跳拉起过快），重跑一次即可');
  log('   ✓ 占位器已接管，心跳不会拉起真面板，目录已解锁');

  // 2. 登记供应链豁免 + 清残留 + pnpm update
  log('2. pnpm update（登记豁免 + 清理 tmp/.ignored 残留）…');
  if (expectVersion) pinReleaseExclude(expectVersion);
  const nm = path.join(PROFILE, 'node_modules');
  for (const junk of fs.readdirSync(nm)) {
    if (junk === '.ignored' || junk.startsWith(`${pkg}_tmp_`)) {
      try { fs.rmSync(path.join(nm, junk), { recursive: true, force: true }); } catch { /* 尽力 */ }
    }
  }
  try { fs.rmSync(path.join(nm, pkg), { recursive: true, force: true }); } catch { /* 目录已被解锁，正常应成功 */ }
  const out = execFileSync('npx',
    // 精确版本强制解析：pnpm 的 packument 缓存会让无版本的 update 静默回退旧版
    ['-y', 'pnpm@11.28.5', 'update', expectVersion ? `${pkg}@${expectVersion}` : pkg],
    { cwd: PROFILE, encoding: 'utf8', shell: true, timeout: 180000 });
  if (out.includes('ERR_PNPM')) fail(`pnpm update 失败：\n${out.slice(-500)}`);

  // 3. 校验安装
  const installed = JSON.parse(fs.readFileSync(path.join(nm, pkg, 'package.json'), 'utf8'));
  if (installed.name !== pkg) fail(`安装包名不符：${installed.name}`);
  log(`3. ✓ 已安装 ${pkg}@${installed.version}`);
  if (expectVersion && installed.version !== expectVersion) fail(`版本不符：期望 ${expectVersion}，实际 ${installed.version}`);
  const lock = fs.readFileSync(path.join(PROFILE, 'pnpm-lock.yaml'), 'utf8');
  const m = lock.match(new RegExp(`${pkg}@([\\d.]+)`));
  if (m) log(`   lockfile 记录：${m[1]}${m[1] === installed.version ? ' ✓' : ' ✗ 与安装不一致'}`);

  // 4. 撤占位器，等心跳从新版拉起面板
  log('4. 撤掉占位器，等待心跳拉起新版面板 …');
  (await holder).close();
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const pr = await probe();
    if (pr && pr.ok && !pr.body.startsWith('placeholder')) {
      log(`   ✓ 面板已复活：${pr.body.slice(0, 80)}`);
      log(`\n✅ ${pkg} 更新完成（${installed.version}）。请重启一次 DSH 使插件页加载校验通过。`);
      return;
    }
  }
  log('\n✅ 安装已完成（' + installed.version + '），但面板 60s 内未自动复活——重启 DSH 即可。');
}

main().catch((e) => fail(e && e.message ? e.message : String(e)));
