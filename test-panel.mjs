/**
 * 会话检索面板（dsh-session-index v2.9.0）单测。
 *
 * 两半各测：
 *   1. 宿主半身 `lib/index.mjs`：路径记录仍在 + 新增的 `session-index` 命令
 *      （list / search / card / status / 报错分支）真的能读 cards.json；
 *   2. 浏览器半身 `lib/client.js`：用桩 ModuleLoader 加载，断言注册了 main 面板与
 *      侧栏图标、词典齐、面板能渲染出搜索框与空态，以及 run() 的三种失败/成功路径。
 *
 * 只读索引，不写任何东西；不碰真实 MCP。
 */
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
// 本文件就放在包根目录（和 smoke.mjs 同级）
const ROOT = here;
const INDEX_DIR = process.env.SESSION_INDEX_DIR
  || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'session-index');

let checks = 0;
let failed = 0;
function check(name, ok, extra) {
  checks++;
  if (ok) console.log('  PASS ' + name + (extra ? ' | ' + extra : ''));
  else { failed++; console.log('  FAIL ' + name + (extra ? ' | ' + extra : '')); }
}

/* ================================================================ 宿主半身 */
const host = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.mjs')).href);
const T = host.__test;

check('宿主导出 __test', !!T && typeof T.runQuery === 'function');

const status = T.runQuery(INDEX_DIR, 'status');
check('status: 读到索引', status.ok === true && status.total > 0, `total=${status.total}`);
check('status: 有 builtAt 与按 app 分组', !!status.builtAt && !!status.byApp, JSON.stringify(status.byApp));
check('status: 暴露索引目录与 cards.json 路径', status.indexDir === INDEX_DIR && status.cardsFile.endsWith('cards.json'));

const list = T.runQuery(INDEX_DIR, 'list 5');
check('list: ok 且最多 5 条', list.ok === true && Array.isArray(list.items) && list.items.length <= 5, `shown=${list.shown}`);
check('list: 按更新时间倒序', (list.items || []).every((it, i, a) => i === 0 || a[i - 1].updatedAt >= it.updatedAt));
const first = (list.items || [])[0] || {};
for (const key of ['id', 'title', 'app', 'updatedAt', 'recordCount', 'keywords', 'digest']) {
  check(`list: 每条有 ${key}`, key in first, String(first[key]).slice(0, 40));
}
check('list: 列表条目是瘦身字段（没有 questions 全文）', !('questions' in first));

const big = T.runQuery(INDEX_DIR, 'list 500');
check('list: 条数上限 200', big.items.length <= 200, String(big.items.length));

const searchWord = (first.keywords && first.keywords[0]) || '会话';
const search = T.runQuery(INDEX_DIR, 'search ' + searchWord);
check('search: 有命中', search.ok === true && search.total > 0, `q=${searchWord} hits=${search.total}`);
check('search: 命中带 score 且按分排', (search.items || []).every((x, i, a) => typeof x.score === 'number' && (i === 0 || a[i - 1].score >= x.score)));

const card = T.runQuery(INDEX_DIR, 'card ' + first.id);
check('card: 取到完整卡', card.ok === true && card.card && card.card.id === first.id);
check('card: 有 decisions / questions / paths', Array.isArray(card.card.decisions) && Array.isArray(card.card.questions) && Array.isArray(card.card.paths),
  `d=${(card.card.decisions || []).length} q=${(card.card.questions || []).length} p=${(card.card.paths || []).length}`);

check('card: 不存在的 id 报错', T.runQuery(INDEX_DIR, 'card 不存在-的会话').ok === false);
check('search 不带关键词报错', T.runQuery(INDEX_DIR, 'search').ok === false);
check('list 默认 60 条', (T.runQuery(INDEX_DIR, 'list').items || []).length <= 60);
check('空输入不抛错', (() => { try { T.runQuery(INDEX_DIR, ''); return true; } catch { return false; } })());

const fakeDir = mkdtempSync(path.join(os.tmpdir(), 'si-idx-'));
try {
  check('索引缺失时给出可读错误', T.runQuery(fakeDir, 'list').ok === false);
  // 缺失场景也别抛
  mkdirSync(fakeDir, { recursive: true });
  writeFileSync(path.join(fakeDir, 'cards.json'), JSON.stringify({ version: 1, builtAt: '2026-01-01T00:00:00.000Z', cards: {} }));
  check('空索引 list 返回空数组', Array.isArray(T.runQuery(fakeDir, 'list').items) && T.runQuery(fakeDir, 'list').items.length === 0);
} finally {
  rmSync(fakeDir, { recursive: true, force: true });
}

// ---- 命令注册（模拟 cordis ctx）--------------------------------------------
const commands = {};
const fakeCtx = {
  effect: (fn) => { try { return fn(); } catch { return undefined; } },
  commands: {
    register: (spec) => { commands.spec = spec; return () => { commands.disposed = true; }; },
  },
  on: () => {},
};
host.apply(fakeCtx);
check('apply 注册了 session-index 命令', !!commands.spec && commands.spec.name === 'session-index', commands.spec && commands.spec.name);
check('命令带用法提示', !!(commands.spec && commands.spec.input && commands.spec.input.hint), commands.spec && commands.spec.input.hint);
check('命令不进会话输入记录', commands.spec && commands.spec.recordInput === false);

const out = await commands.spec.handler({ rawInput: 'status' });
check('命令 handler 返回 success', out.kind === 'success', out.kind);
const parsed = JSON.parse(out.text);
check('命令 payload 可解析且 ok', parsed.ok === true && parsed.total > 0, `total=${parsed.total}`);

const out2 = await commands.spec.handler({ rawInput: 'card 没有这个' });
check('命令 handler 失败走 error 分支', out2.kind === 'error', out2.kind);
check('error 文案是人话（不是 JSON）', !out2.text.trim().startsWith('{') && out2.text.includes('没有这张卡'), out2.text.slice(0, 40));

const out3 = await commands.spec.handler({ rawInput: '' });
check('空输入按 list 处理', out3.kind === 'success' && JSON.parse(out3.text).ok === true);

// 拿不到 commands 服务也不能抛（会影响 MCP 行之前的整棵插件树）
const bareCtx = { on: () => {}, effect: () => undefined };
let threw = false;
try { host.apply(bareCtx); } catch { threw = true; }
check('没有 commands 服务时不抛错', !threw);

// 现有职责没丢：server-path.txt 还会写
const sp = path.join(INDEX_DIR, 'server-path.txt');
check('仍会记录 MCP 入口路径', existsSync(sp) && readFileSync(sp, 'utf8').trim().length > 0, existsSync(sp) ? readFileSync(sp, 'utf8').trim() : 'missing');

/* ================================================================ 浏览器半身 */
const loaded = [];
const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() });
const React = {
  createElement: h,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
  Fragment: 'fragment',
};
const store = new Map();
globalThis.window = {
  __ModuleLoader__: { load: (mod) => loaded.push(mod) },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: () => 0,
  clearInterval: () => {},
  localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
  open: () => {},
};
globalThis.document = {
  createElement: () => ({ textContent: '', id: '' }),
  head: { appendChild: () => {} },
  getElementById: () => null,
};
const req = (name) => {
  if (name === 'react') return React;
  if (name === 'react/jsx-runtime') return { jsx: h, jsxs: h, Fragment: 'fragment' };
  throw new Error('unexpected require: ' + name);
};

const clientFile = path.join(ROOT, 'lib', 'client.js');
const clientSrc = readFileSync(clientFile, 'utf8');
// eslint-disable-next-line no-new-func
new Function('window', 'document', 'navigator', clientSrc)(globalThis.window, globalThis.document, { clipboard: { writeText: async () => {} } });

check('client 模块已注册', loaded.length === 1);
const mod = loaded[0];
check('client 模块 id', mod.id === 'dsh-session-index', mod.id);
const cx = mod.factory(req);
check('client 导出 apply', typeof cx.apply === 'function');
check('client 导出 name', cx.name === 'dsh-session-index', cx.name);
check('client 声明 remote.commands 依赖', Array.isArray(cx.inject) && cx.inject.includes('remote.commands'), JSON.stringify(cx.inject));

const mainRegs = [];
const sideRegs = [];
const dicts = [];
/** 词典要等 apply 之后才有，所以这里按调用时的 dicts 现取。 */
const zh = (key) => {
  const d = dicts[0] && dicts[0].dict && dicts[0].dict.zh;
  return (d && d[key]) || key;
};
const ctx2 = {
  effect: (fn) => { try { return fn(); } catch { return undefined; } },
  locale: {
    register: (ns, dict) => { dicts.push({ ns, dict }); return () => {}; },
    bind: () => (key) => zh(key),
  },
  slots: {
    // 真实 inject() 会在槽位就绪后跑回调；generator 要推进一格。
    inject: (slot, cb) => { const out = cb(); if (out && typeof out.next === 'function') out.next(); },
    register: (opts, comp) => { (opts.name === 'main' ? mainRegs : sideRegs).push({ opts, comp }); return () => {}; },
  },
};
cx.apply(ctx2);

check('注册了 main 面板', mainRegs.length === 1, String(mainRegs.length));
check('注册了侧栏入口', sideRegs.length === 1, String(sideRegs.length));
check('词典已注册（zh + en）', dicts.length === 1 && !!dicts[0].dict.zh && !!dicts[0].dict.en);
check('侧栏 label 用词典', typeof sideRegs[0].opts.label === 'function' && sideRegs[0].opts.label() === '会话检索', sideRegs[0].opts.label());

const panelEntry = mainRegs[0];
check('main 面板 key 正确', panelEntry.opts.key === 'session-index', panelEntry.opts.key);

// run() 的三条路径（宿主半身没加载 / 正常 / 值缺失）
const run = panelEntry.opts.inject().run;
check('面板拿到 run 函数', typeof run === 'function');

// 用带桩 remote 的 ctx 重新 apply 一次，拿到对应的 run
const calls = [];
const ctx3 = {
  effect: (fn) => { try { return fn(); } catch { return undefined; } },
  locale: { register: () => () => {}, bind: () => (k) => k },
  slots: {
    inject: (slot, cb) => { const out = cb(); if (out && typeof out.next === 'function') out.next(); },
    register: (opts, comp) => { (opts.name === 'main' ? mainRegs2 : sideRegs2).push({ opts, comp }); return () => {}; },
  },
  remote: {
    commands: {
      execute: async (sessionId, line) => { calls.push(line); return { ok: true, value: { result: { kind: 'success', text: JSON.stringify({ ok: true, items: [] }) } } }; },
    },
  },
};
const mainRegs2 = [];
const sideRegs2 = [];
cx.apply(ctx3);
const run2 = mainRegs2[0].opts.inject().run;
// 命令通道按 agent 寻址：第一个参数必须是真实会话 id 字符串。
const payload = await run2('sess-unit-test', 'session-index list 3');
check('run: 成功路径解析出 payload', payload && payload.ok === true && Array.isArray(payload.items), JSON.stringify(calls));
check('run: 把命令行原样发给宿主', calls[0] === 'session-index list 3', calls[0]);

// 宿主没加载 → 人话错误
// apply 时 ctx.remote 不存在 → run 抛 hostUnavailable
const run4 = (() => {
  let fn = null;
  const c = {
    effect: () => undefined, locale: { register: () => () => {}, bind: () => (k) => k },
    slots: {
      inject: (slot, cb) => { const out = cb(); if (out && typeof out.next === 'function') out.next(); },
      register: (opts, comp) => { if (opts.name === 'main') fn = opts.inject().run; return () => {}; },
    },
  };
  cx.apply(c);
  return fn;
})();
let msg = '';
try { await run4('sess-unit-test', 'session-index status'); } catch (e) { msg = e.message; }
check('run: 宿主没加载时给人话提示', /宿主半身没加载/.test(msg), msg.slice(0, 40));

// value 缺失（Host 半身没注册命令）也走同一条提示
const ctx5run = (() => {
  let fn = null;
  const c = {
    effect: () => undefined, locale: { register: () => () => {}, bind: () => (k) => k },
    slots: {
      inject: (slot, cb) => { const out = cb(); if (out && typeof out.next === 'function') out.next(); },
      register: (opts, comp) => { if (opts.name === 'main') fn = opts.inject().run; return () => {}; },
    },
    remote: { commands: { execute: async () => ({ ok: true, value: undefined }) } },
  };
  cx.apply(c);
  return fn;
})();
let msg2 = '';
try { await ctx5run('sess-unit-test', 'session-index status'); } catch (e) { msg2 = e.message; }
check('run: 命令未解析时也给人话提示', /宿主半身没加载/.test(msg2), msg2.slice(0, 40));

// 没有可寻址会话时不许发请求：undefined / 空串 / 快照对象都要被挡住，
// 否则网关会回 `gateway/input-invalid ... wire field "agentId"`（v2.6.0 的真实故障）。
for (const bad of [undefined, '', { byId: {}, ids: [] }]) {
  let badMsg = '';
  let sent = false;
  const guardRun = (() => {
    let fn = null;
    const c = {
      effect: () => undefined, locale: { register: () => () => {}, bind: () => (k) => k },
      slots: {
        inject: (slot, cb) => { const out = cb(); if (out && typeof out.next === 'function') out.next(); },
        register: (opts) => { if (opts.name === 'main') fn = opts.inject().run; return () => {}; },
      },
      remote: { commands: { execute: async () => { sent = true; return { ok: true, value: { result: { kind: 'success', text: '{}' } } }; } } },
    };
    cx.apply(c);
    return fn;
  })();
  try { await guardRun(bad, 'session-index list 3'); } catch (e) { badMsg = e.message; }
  check(`run: 会话 id ${JSON.stringify(bad)} 被挡住且没发请求`, badMsg.length > 0 && sent === false, badMsg.slice(0, 30));
}

// 快照 → 可寻址 id：跳过已归档/已移除，优先屏上会话，其次最新
const pick = cx.__test && cx.__test.pickSessionId;
check('client 暴露 pickSessionId', typeof pick === 'function');
const snap = {
  ids: ['a-gone', 'b-new', 'c-shown', 'd-old'],
  byId: {
    'a-gone': { archived: true, updatedAt: 9 },
    'b-new': { updatedAt: 300 },
    'c-shown': { updatedAt: 100, retainedBy: { view: 1 } },
    'd-old': { updatedAt: 50 },
  },
};
check('pickSessionId: 跳过已归档', pick(snap) !== 'a-gone', pick(snap));
check('pickSessionId: 优先屏上会话', pick(snap) === 'c-shown', pick(snap));
check('pickSessionId: 没有屏上会话时取最新', pick({ ids: ['x', 'y'], byId: { x: { updatedAt: 10 }, y: { updatedAt: 20 } } }) === 'y');
check('pickSessionId: 已移除的会话不算', pick({ ids: ['r'], byId: { r: { removed: true, updatedAt: 99 } } }) === undefined);
check('pickSessionId: 空快照返回 undefined', pick(undefined) === undefined && pick({}) === undefined);
check('pickSessionId: 支持 list.byId 形态', pick({ list: { byId: { z: { updatedAt: 1 } } } }) === 'z');
check('pickSessionId: 返回字符串而不是快照对象', typeof pick(snap) === 'string', typeof pick(snap));

// ---- 面板渲染 ---------------------------------------------------------------
const Panel = panelEntry.comp;
const tree = Panel({ t: zh, run: async () => ({ ok: true, items: [] }) });
const flat = [];
(function walk(n) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) { n.forEach(walk); return; }
  flat.push(n);
  (n.children || []).forEach(walk);
})(tree);

check('面板渲染出根容器', flat.some((n) => n.props && String(n.props.className || '').includes('si-panel')));
check('面板有搜索框', flat.some((n) => n.type === 'input' && String(n.props.className || '').includes('si-input')));
check('面板有刷新按钮', flat.some((n) => n.type === 'button' && String(n.props.className || '').includes('si-btn')));
check('面板有列表容器', flat.some((n) => n.props && String(n.props.className || '').includes('si-list')));
const zhDict = dicts[0] && dicts[0].dict && dicts[0].dict.zh || {};
check('空态与宿主不可用文案可用', (zhDict.empty || '').length > 0 && (zhDict.hostUnavailable || '').length > 0);

// 侧栏图标是 svg
const Icon = sideRegs[0].comp;
const iconTree = Icon({ size: 18 });
const iconFlat = [];
(function walk2(n) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) { n.forEach(walk2); return; }
  iconFlat.push(n);
  (n.children || []).forEach(walk2);
})(iconTree);
check('侧栏图标渲染 svg', iconFlat.some((n) => n.type === 'svg'));
check('图标画了卡片与放大镜', iconFlat.some((n) => n.type === 'circle') && iconFlat.some((n) => n.type === 'path'));

/* ================================================================ 本地 HTTP 通道 */
const { startPanelHttp, handleRequest, allowedOrigin, DEFAULT_PORTS } = await import(
  pathToFileURL(path.join(ROOT, 'lib', 'http-api.mjs')).href
);
const { runQuery: sharedQuery } = await import(pathToFileURL(path.join(ROOT, 'lib', 'panel-api.mjs')).href);

{
  const u = (p) => new URL(p, 'http://127.0.0.1:8799');
  check('默认端口从 8799 起、按序顺延', DEFAULT_PORTS[0] === 8799 && DEFAULT_PORTS.length > 1, DEFAULT_PORTS.slice(0, 3).join(','));
  const health = handleRequest(INDEX_DIR, u('/api/health'));
  check('http: health 可用', health.code === 200 && health.body.ok === true, health.body.service);

  const status = handleRequest(INDEX_DIR, u('/api/status')).body;
  check('http: status 读到索引', status.ok === true && status.total > 0, `total=${status.total}`);

  const list = handleRequest(INDEX_DIR, u('/api/list?limit=3')).body;
  check('http: list 最多 3 条', list.ok === true && list.items.length <= 3, `n=${list.items.length}`);
  check('http: list 是瘦身字段（不带 questions 全文）', !('questions' in list.items[0]), Object.keys(list.items[0]).join(','));
  check('http: list 带关键词与摘要', Array.isArray(list.items[0].keywords) && typeof list.items[0].digest === 'string');

  const word = (list.items[0].keywords || [])[0] || '会话';
  const search = handleRequest(INDEX_DIR, u('/api/search?q=' + encodeURIComponent(word))).body;
  check('http: search 有命中', search.ok === true && search.total > 0, `q=${word}`);
  check('http: search 带 score 与命中词', typeof search.items[0].score === 'number' && Array.isArray(search.items[0].hitKeywords));

  const card = handleRequest(INDEX_DIR, u('/api/card?id=' + encodeURIComponent(list.items[0].id))).body;
  check('http: card 取到全文（含 decisions）', card.ok === true && Array.isArray(card.card.decisions));
  check('http: 未知路由给 404', handleRequest(INDEX_DIR, u('/nope')).code === 404);

  // 跨源策略：会话卡是会话元数据，远程网页不许读；本地源（渲染进程）放行。
  check('cors: 无 Origin 放行（curl）', allowedOrigin(undefined) === '*');
  check('cors: null 源放行（file:// 沙箱）', allowedOrigin('null') === '*');
  check('cors: 远程站点被拒', allowedOrigin('https://evil.example.com') === null
    && allowedOrigin('http://192.168.1.10:8080') === null);
  check('cors: 回环源放行', allowedOrigin('http://127.0.0.1:8799') === 'http://127.0.0.1:8799'
    && allowedOrigin('http://localhost:8799') === 'http://localhost:8799');
  check('cors: 非 http 源（app:// 等）放行', allowedOrigin('app://dsh.desktop') === 'app://dsh.desktop'
    && allowedOrigin('file://') === 'file://');

  // 口径一致：HTTP 通道与斜杠命令/宿主半身走同一套实现，结果必须逐条相同。
  const viaHttp = search.items.map((i) => i.id).join(',');
  const viaHost = sharedQuery(INDEX_DIR, 'search ' + word).items.map((i) => i.id).join(',');
  check('http 与命令通道口径一致（同一套实现）', viaHttp === viaHost && viaHost.length > 0, viaHttp.slice(0, 60));
}

// 起真服务：端口占用顺延，面板的探测代码要能认出它
{
  const ports = [8912, 8913, 8914];
  const srv = startPanelHttp({ indexDir: INDEX_DIR, ports, log: () => {} });
  let base = null;
  if (srv) {
    for (let i = 0; i < 40 && !srv.server.listening; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const addr = srv.server.address();
    if (addr && addr.port) base = `http://127.0.0.1:${addr.port}`;
  }
  check('http 服务能起来', Boolean(base), String(base));

  if (base) {
    const res = await fetch(base + '/api/list?limit=2', { cache: 'no-store' });
    const body = await res.json();
    check('http 服务可被 fetch 读取', res.ok && body.ok === true, `status=${res.status}`);

    // 面板的探测逻辑：把测试端口塞进候选列表，probeHttpBase 应该认出它
    const test = cx.__test;
    test.HTTP_PORTS.push(Number(base.split(':').pop()));
    try {
      const probed = await test.probeHttpBase();
      check('面板能探到 HTTP 端点', typeof probed === 'string' && probed.length > 0, String(probed));
    } finally {
      test.HTTP_PORTS.pop();
    }

    // 只读：POST 要被拒
    const post = await fetch(base + '/api/list', { method: 'POST' });
    check('http 服务拒绝写操作', post.status === 405, String(post.status));

    // 跨源：远程网页拿不到 CORS 头，本地源能拿到
    const evil = await fetch(base + '/api/list?limit=1', { headers: { Origin: 'https://evil.example.com' } });
    check('http 对远程源不给 CORS 头', !evil.headers.get('access-control-allow-origin'), String(evil.headers.get('access-control-allow-origin')));
    const localOrigin = `http://127.0.0.1:${base.split(':').pop()}`;
    const local = await fetch(base + '/api/list?limit=1', { headers: { Origin: localOrigin } });
    check('http 对本地源回显 CORS 头', local.headers.get('access-control-allow-origin') === localOrigin,
      String(local.headers.get('access-control-allow-origin')));
    const noOrigin = await fetch(base + '/api/health');
    check('http 无 Origin 时给 *', noOrigin.headers.get('access-control-allow-origin') === '*',
      String(noOrigin.headers.get('access-control-allow-origin')));

    await new Promise((r) => srv.server.close(r));
  }
}

console.log(`\n==== ${checks - failed}/${checks} session-index panel checks passed ====`);
process.exit(failed === 0 ? 0 : 1);
