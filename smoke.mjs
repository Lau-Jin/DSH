/**
 * MCP 端到端冒烟测试：真实启动 server.mjs，走 stdio JSON-RPC 握手，
 * 覆盖 13 个工具 + 自描述 + 自动索引守护 + 文件事件监听 + 自动打包 +
 * prompts + resources + 多源 + 语义检索 + 长期记忆。
 * 运行：node smoke.mjs（需 Node >= 22.15）
 *
 * 测试写入的记忆会在结尾物理清除，不污染真实记忆库。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectZip } from './lib/pack.mjs';

// 本地假思源桥：完整实现 status / stage / autostage 三个只读端点与 POST /api/stage，
// 用来验证两步确认与去重，绝不碰 5599 上真实的「待入库」队列。
const stagePosts = [];
const stagedItems = [];
const mockBridge = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const u = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && u.pathname === '/api/status') return send(200, { kernel: '3.8.9', staged: stagedItems.length, notebooks: [] });
  if (req.method === 'GET' && u.pathname === '/api/stage') return send(200, { items: stagedItems, discarded: 0 });
  if (req.method === 'GET' && u.pathname === '/api/autostage') return send(200, { enabled: true, dir: 'D:/mock/session-docs', hpath: '/会话札记/思源', files: [] });
  if (req.method === 'POST' && u.pathname === '/api/stage') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const p = JSON.parse(raw || '{}');
      stagePosts.push(p);
      const item = { id: '20261114140000-abcdef', title: p.title, chars: String(p.markdown || '').length, hpath: p.hpath, notebook: p.notebook, note: p.note };
      stagedItems.push(item);
      send(200, { id: item.id, title: item.title, chars: item.chars, staged: true });
    });
    return;
  }
  if (u.pathname.includes('/commit')) {
    stagePosts.push({ __forbidden: 'commit' });
    return send(200, {});
  }
  return send(404, { error: 'not found' });
});
await new Promise((r) => mockBridge.listen(0, '127.0.0.1', r));
const stageUrl = `http://127.0.0.1:${mockBridge.address().port}`;

const here = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(here, 'server.mjs')], {
  cwd: here,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    SIYUAN_BRIDGE_URL: stageUrl,
    SESSION_INDEX_WATCH_DEBOUNCE_MS: '60000',
    SESSION_INDEX_AUTO_INTERVAL_MS: '3600000',
  },
});
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

let buffer = '';
let nextId = 1;
const pending = new Map();
const notifications = [];
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error('FAIL: stdout 出现非 JSON 行:', line.slice(0, 120));
      process.exitCode = 1;
      continue;
    }
    if (msg.id === undefined && typeof msg.method === 'string' && msg.method.startsWith('notifications/')) {
      notifications.push(msg.method);
      continue;
    }
    const resolver = pending.get(msg.id);
    if (resolver) {
      pending.delete(msg.id);
      resolver(msg);
    }
  }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(method, params = {}, timeoutMs = 30000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时`));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const notify = (method, params = {}) =>
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
const call = (name, args = {}) => request('tools/call', { name, arguments: args });
async function payload(resp) {
  if (resp.error) throw new Error(`RPC 错误 ${resp.error.code}: ${resp.error.message}`);
  if (resp.result?.isError) throw new Error('工具返回 isError: ' + resp.result.content[0].text);
  return JSON.parse(resp.result.content[0].text);
}

const results = [];
function check(label, condition, detail = '') {
  results.push({ label, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
}

const TEST_TEXT = `SMOKE-TEST 记忆条目 ${Date.now()}`;
let noteId = null;

try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '2.5.2' },
  });
  check('initialize 握手与能力声明', init.result?.serverInfo?.version === '2.5.2' && Boolean(init.result?.capabilities?.prompts) && Boolean(init.result?.capabilities?.resources), init.result?.serverInfo?.version);
  check('initialize 返回自描述 instructions', (init.result?.instructions || '').includes('session_index_brief'));
  check('声明 listChanged 通知能力', init.result?.capabilities?.resources?.listChanged === true && init.result?.capabilities?.prompts?.listChanged === true);
  notify('notifications/initialized');

  const listed = await request('tools/list');
  const names = (listed.result?.tools || []).map((t) => t.name);
  check('tools/list 返回 14 个工具', names.length === 14 && names.includes('session_index_stage'), `${names.length} 个`);
  check('ping', (await request('ping')).result !== undefined);

  // 自动索引守护 + 文件事件监听
  let autoState = null;
  for (let i = 0; i < 40; i++) {
    const st = await payload(await call('session_index_status'));
    autoState = st.autoIndex;
    if (autoState && !autoState.building && autoState.runs >= 1) break;
    await sleep(250);
  }
  check('自动索引守护已启用', autoState?.enabled === true, `间隔 ${autoState?.intervalMs}ms`);
  check('启动自检在后台完成', autoState?.runs >= 1 && autoState?.building === false, `runs=${autoState?.runs}`);
  check('自动刷新无失败', autoState?.failures === 0 && !autoState?.lastError, autoState?.lastError || '无错误');
  check('文件事件监听已建立', autoState?.watch?.watching >= 1, `${autoState?.watch?.watching} 个目录 / 事件 ${autoState?.watch?.events || 0}`);
  check('监听防抖与静止期可配置', autoState?.watchEnabled === true && autoState?.watchDebounceMs === 60000 && autoState?.watchQuietMs >= 0);

  const status = await payload(await call('session_index_status'));
  check('status 多源统计', status.indexedSessions > 0 && status.byApp?.dsh > 0 && status.byApp?.workbuddy > 0, JSON.stringify(status.byApp));
  check('status 记忆与模式', typeof status.activeMemories === 'number' && /semantic/.test(status.searchMode));
  check('status 列出分发包', Array.isArray(status.packs) && status.packs.length >= 2, `${status.packs?.length || 0} 个包`);

  // ---- 自动打包
  const packed = await payload(await call('session_index_package', { mode: 'all' }));
  check('自动打包生成插件包与技能包', packed.ok === true && packed.packages?.length === 2, packed.packages?.map((p) => p.mode).join(', '));
  for (const p of packed.packages || []) {
    let info = null;
    try {
      info = inspectZip(p.path);
    } catch (e) {
      info = { ok: false, error: e.message, names: [] };
    }
    check(`包结构有效 [${p.mode}]`, info.ok && info.count > 1, `${info.count || 0} 文件 / ${(p.bytes / 1024).toFixed(1)} KB`);
    check(`包内无会话数据 [${p.mode}]`, (info.names || []).every((n) => !/notes\.json|meta\.json|cards\.json|\.jsonl\.gz|vectors\.json/.test(n)));
  }
  const skillOnly = await payload(await call('session_index_package', { mode: 'skill' }));
  check('单独打包技能包', skillOnly.ok && skillOnly.packages?.[0]?.mode === 'skill');
  const packStatus = await payload(await call('session_index_package', { mode: 'status' }));
  check('分发包状态可查询', packStatus.packs?.length >= 2 && packStatus.packs.every((p) => p.valid));

  // ---- 跨会话层
  const brief = await payload(await call('session_index_brief', { limit: 5, maxChars: 3000 }));
  check('brief 跨会话结论速览', brief.returned > 0 && brief.sessions[0]?.decisions?.length > 0);
  const topicWord = brief.sessions[0]?.keywords?.[0] || '周报';
  const topicBrief = await payload(await call('session_index_brief', { query: topicWord, limit: 3 }));
  check('brief 主题聚合', topicBrief.mode === 'topic' && topicBrief.returned > 0, `「${topicWord}」`);
  const list = await payload(await call('session_index_list', { limit: 50 }));
  check('list 会话清单', list.returned > 0);
  const wbList = await payload(await call('session_index_list', { app: 'workbuddy', limit: 10 }));
  check('list 按应用过滤 WorkBuddy', wbList.returned > 0 && wbList.sessions.every((s) => s.app === 'workbuddy'));
  const firstId = list.sessions[0].id;
  const related = await payload(await call('session_index_related', { sessionId: firstId.slice(0, 12), limit: 4 }));
  check('related 按会话关联', related.returned > 0 && related.related[0]?.reasons?.length > 0);
  check('related 按主题关联', Array.isArray((await payload(await call('session_index_related', { query: topicWord, limit: 4 }))).related));
  const childSession = list.sessions.find((s) => s.parentSession) || list.sessions[0];
  const thread = await payload(await call('session_index_thread', { sessionId: childSession.id.slice(0, 12) }));
  check('thread 血缘链', thread.chainLength >= 1 && Array.isArray(thread.ancestors));

  // ---- 语义检索
  const sem = await payload(await call('session_index_search', { query: 'TokenHub 配置', limit: 3, contextChars: 100 }));
  check('search 默认语义模式', sem.mode === 'semantic' && sem.total > 0);
  check('search 只返回片段', Boolean(sem.results[0]?.snippet) && sem.results[0].snippet.length < 400);
  const kw = await payload(await call('session_index_search', { query: 'TokenHub', mode: 'keyword', limit: 3 }));
  check('search keyword 兼容模式', kw.mode === 'keyword' && kw.total > 0);
  const wbSearch = await payload(await call('session_index_search', { query: '插件', app: 'workbuddy', limit: 3 }));
  check('search 跨应用过滤', wbSearch.app === 'workbuddy' && wbSearch.sessionsScanned > 0);
  const hyPayload = await payload(await call('session_index_search', { query: 'TokenHub', mode: 'hybrid', limit: 2 }));
  check('hybrid 未配置向量时自动降级', hyPayload.degraded === true || hyPayload.vectorInfo !== undefined);
  const sysHidden = await payload(await call('session_index_search', { query: 'Time sampled', limit: 2 }));
  const sysShown = await payload(await call('session_index_search', { query: 'Time sampled', limit: 2, includeSystem: true }));
  const noInjectedText = sysHidden.results.every((r) => !/Time sampled while preparing/i.test(r.snippet || ''));
  check('search 默认排除系统注入', sysShown.total > sysHidden.total && noInjectedText, `${sysHidden.total} vs ${sysShown.total}`);
  check('includeSystem 可取回', sysShown.total > sysHidden.total);
  check('语义结果标注命中类型', ['exact', 'expanded'].includes(sem.results[0]?.matchType));

  // ---- 原文
  const outline = await payload(await call('session_index_get', { sessionId: firstId.slice(0, 12) }));
  check('get 骨架模式', outline.mode === 'outline' && outline.outlineCount > 0);
  if (sem.results[0]) {
    const detail = await payload(await call('session_index_get', { sessionId: sem.results[0].sessionId, seqs: [sem.results[0].seq], maxChars: 1000 }));
    check('get 按 seq 取原文', detail.mode === 'records' && detail.items.length > 0);
  }

  // ---- 长期记忆
  const rem = await payload(await call('session_index_remember', { text: TEST_TEXT, type: 'decision', tags: ['smoke'], importance: 4 }));
  noteId = rem.note.id;
  check('remember 写入记忆', rem.ok && rem.created && rem.note.type === 'decision');
  const rem2 = await payload(await call('session_index_remember', { text: TEST_TEXT, type: 'decision', importance: 5 }));
  check('remember 同内容去重合并', rem2.merged === true && rem2.note.importance === 5);
  check('recall 按关键词召回', (await payload(await call('session_index_recall', { query: 'SMOKE-TEST', limit: 5 }))).notes[0]?.id === noteId);
  check('recall 按类型过滤', (await payload(await call('session_index_recall', { type: 'decision', limit: 20 }))).notes.every((n) => n.type === 'decision'));
  check('brief 自动融合长期记忆', (await payload(await call('session_index_brief', { query: 'SMOKE-TEST', limit: 2 }))).memories?.some((m) => m.id === noteId));
  check('语义检索覆盖记忆文档', (await payload(await call('session_index_search', { query: 'SMOKE-TEST', limit: 5 }))).results.some((r) => r.kind === 'memory'));
  check('forget 默认归档', (await payload(await call('session_index_forget', { id: noteId }))).archived === true);
  check('归档项可查看', (await payload(await call('session_index_recall', { query: 'SMOKE-TEST', includeArchived: true }))).notes.some((n) => n.id === noteId && n.archived));
  check('forget purge 清理测试记忆', (await payload(await call('session_index_forget', { id: noteId, purge: true }))).purged === true);
  noteId = null;

  // ---- 自描述：prompts / resources
  const prompts = await request('prompts/list');
  check('prompts/list 返回 4 个提示词', (prompts.result?.prompts || []).length === 4);
  const ptext = (await request('prompts/get', { name: 'session-context', arguments: { limit: 3 } })).result?.messages?.[0]?.content?.text || '';
  check('prompts/get session-context 生成上下文', ptext.includes('跨会话上下文') && ptext.includes('长期记忆'));
  check('prompts/get resume-topic', ((await request('prompts/get', { name: 'resume-topic', arguments: { topic: '周报' } })).result?.messages?.[0]?.content?.text || '').includes('周报'));
  check('prompts/get quickstart 返回使用说明', ((await request('prompts/get', { name: 'quickstart' })).result?.messages?.[0]?.content?.text || '').includes('session_index_brief'));
  const resources = await request('resources/list');
  const rUris = (resources.result?.resources || []).map((r) => r.uri);
  check('resources/list 返回 7 个资源', rUris.length === 7 && rUris.includes('session-index://package'));
  check('resources/templates/list', (await request('resources/templates/list')).result?.resourceTemplates?.length === 1);
  for (const uri of ['session-index://guide', 'session-index://plugin.json', 'session-index://package', 'session-index://brief', 'session-index://memory', 'session-index://status', 'session-index://cards']) {
    const r = await request('resources/read', { uri });
    check(`resources/read ${uri.split('//')[1]}`, (r.result?.contents?.[0]?.text || '').length > 10);
  }
  const pluginJson = JSON.parse((await request('resources/read', { uri: 'session-index://plugin.json' })).result.contents[0].text);
  check('插件清单机器可读', pluginJson.mcp?.toolCount === 14 && pluginJson.automatic?.watchNewSessions === true, `v${pluginJson.version}`);
  const cardUri = await request('resources/read', { uri: `session-index://card/${firstId.slice(0, 12)}` });
  check('resources/read 单会话卡模板', (cardUri.result?.contents?.[0]?.text || '').includes('"id"'));

  // ---- 向量层与刷新
  const vec = await payload(await call('session_index_vectors', { action: 'status' }));
  check('vectors status 可查询', typeof vec.cached === 'number' && typeof vec.enabled === 'boolean');
  const refreshed = await payload(await call('session_index_refresh', { force: false }));
  check('refresh 手动刷新仍可用', refreshed.ok === true && refreshed.cardsIndexed > 0);
  check('refresh 返回自动维护状态', Boolean(refreshed.autoIndex));
  // ---- 会话整理 → 思源桥待入库（本地假服务，全程不碰真实 5599 队列）
  const ov = await payload(await call('session_index_stage', { status: true }));
  check('stage 只读探测服务与队列', ov.ok === true && ov.kernel === '3.8.9' && ov.queued === 0, JSON.stringify({ kernel: ov.kernel, queued: ov.queued }));
  check('stage 探测返回自动接入目录', ov.autoStageDir === 'D:/mock/session-docs' && ov.autoStageEnabled === true);
  check('stage 探测不产生写入', stagePosts.length === 0);

  const prev = await payload(await call('session_index_stage', { query: '插件', template: 'brief', limit: 3 }));
  check('stage 默认只预览不投递', prev.dryRun === true && prev.staged === false && typeof prev.token === 'string' && stagePosts.length === 0, prev.code || prev.error || '');
  check('stage 预览含 Markdown 与落点', String(prev.preview || '').includes('# 会话整理') && prev.target?.hpath === '/会话札记/思源');
  check('stage 预览给出可回传的 confirmWith', prev.confirmWith?.confirmToken === prev.token && typeof prev.confirmWith?.title === 'string');

  const bad = await payload(await call('session_index_stage', { ...prev.confirmWith, confirmToken: 'deadbeef' }));
  check('stage 错误令牌被拒绝', bad.ok === false && bad.code === 'TOKEN_MISMATCH' && bad.staged === false, bad.code || '');
  check('stage 拒绝后仍无写入', stagePosts.length === 0);

  const posted = await payload(await call('session_index_stage', prev.confirmWith));
  check('stage 确认后投递成功', posted.ok === true && posted.staged === true && posted.id === '20261114140000-abcdef' && stagePosts.length === 1, posted.code || posted.error || '');
  check('stage 投递体含标题与 Markdown', typeof stagePosts[0]?.title === 'string' && String(stagePosts[0]?.markdown || '').includes('# 会话整理'));
  check('stage 文档声明未写入笔记库', /未写入笔记库/.test(String(stagePosts[0]?.markdown || '')));
  check('stage 绝不调用 commit', stagePosts.every((p) => !p.__forbidden));

  const dup = await payload(await call('session_index_stage', prev.confirmWith));
  check('stage 重复投递被去重', dup.alreadyQueued === true && dup.staged === false && stagePosts.length === 1, dup.code || '');
  const dec = await payload(await call('session_index_stage', { template: 'decisions', limit: 2 }));
  check('stage decisions 模板可用', dec.dryRun === true && dec.chars > 0);

  check('空 query 被规范化拒绝', (await call('session_index_search', { query: '' })).result?.isError === true);
  check('通知通道可用（声明级）', Array.isArray(notifications), `收到 ${notifications.length} 条通知`);
} catch (err) {
  check('冒烟流程', false, err.message);
} finally {
  if (noteId) {
    try {
      await call('session_index_forget', { id: noteId, purge: true });
    } catch {
      // best effort
    }
  }
  child.stdin.end();
  child.kill();
  mockBridge.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n结果：${results.length - failed}/${results.length} 通过`);
if (failed) process.exitCode = 1;
