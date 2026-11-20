/**
 * 新能力单测（v3.0）：工作区归一化 / 未完成事项抽取 / 接续包 / 索引体检 / 检索分组。
 *
 * 全程临时目录 + 造数据，不碰真实索引；不需要网络。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ws = await import(pathToFileURL(path.join(ROOT, 'lib', 'workspace.mjs')).href);
const todos = await import(pathToFileURL(path.join(ROOT, 'lib', 'todos.mjs')).href);
const panelApi = await import(pathToFileURL(path.join(ROOT, 'lib', 'panel-api.mjs')).href);

let checks = 0;
let failed = 0;
function check(name, ok, extra) {
  checks += 1;
  if (ok) console.log('  PASS ' + name + (extra ? ' | ' + extra : ''));
  else { failed += 1; console.log('  FAIL ' + name + (extra ? ' | ' + extra : '')); }
}

/* ------------------------------------------------------------ 工作区归一化 */
{
  const variants = [
    'D:\\WorkBuddy工作区\\Tool开发\\DSH',
    'd:\\WorkBuddy工作区\\Tool开发\\DSH',
    'd:/WorkBuddy工作区/Tool开发/DSH',
    'd-WorkBuddy工作区-Tool开发-DSH',
  ];
  check('同一项目的 4 种写法归一到同一个项目键',
    new Set(variants.map((v) => ws.projectKeyOf(v))).size === 1,
    variants.map((v) => ws.projectKeyOf(v)).join('/'));
  check('项目名取最深一段', ws.projectOf('D:\\a\\b\\DSH') === 'DSH', ws.projectOf('D:\\a\\b\\DSH'));
  check('WorkBuddy 编码目录可还原', ws.projectOf('d-WorkBuddy工作区-Tool开发-DSH') === 'DSH');
  check('完整路径前缀匹配（子目录也算）', ws.matches('D:\\a\\b\\c', 'D:\\a\\b') === true);
  check('项目名匹配', ws.matches('D:\\x\\DSH', 'dsh') === true);
  check('不同项目不匹配', ws.matches('D:\\x\\other', 'dsh') === false);
  check('空过滤放行一切', ws.matches('whatever', '') === true);

  const groups = ws.groupByProject([
    { workspace: 'D:\\p\\DSH', updatedAt: 10 },
    { workspace: 'd-WorkBuddy-p-DSH', updatedAt: 20 },
    { workspace: 'D:\\p\\Other', updatedAt: 30 },
  ]);
  check('分组把同一项目的两种写法合成一组', groups.length === 2, groups.map((g) => `${g.project}:${g.count}`).join(', '));
  check('分组记录同一项目的路径写法数',
    groups.find((g) => g.project === 'DSH').workspaces.length === 2);
  check('分组按最近更新排序', groups[0].project === 'Other', groups[0].project);
}

/* ------------------------------------------------------------ 未完成事项抽取 */
{
  const rec = (i, text, role = 'assistant') => ({ i, role, t: 'text', text, ts: 1000 + i });
  const records = [
    rec(1, '这里的登录逻辑已经修复完毕，可以收工了。'),                     // 有「修复」但已完成的语气 → 不该收
    rec(2, '下一步要补齐 nacos 的配置模板，还没做。'),                     // 应被收
    rec(3, 'TODO: 把 worker 的并发数从 4 调到 8'),                         // 应被收（todo）
    rec(4, '这个模块还没写完，待验证后再合并。'),                          // 应被收
    rec(5, '好的，收到。'),                                              // 噪声
    rec(6, '已完成：把所有旧分片清理干净。'),                              // 已完成的 todo 语气 → 不该收
    rec(7, '待办：跑一次全量冒烟'),                                       // 应被收
    { i: 8, role: 'system', t: 'text', text: 'Time sampled while preparing turn 1, step 1', ts: 1008 }, // 系统注入
  ];
  const items = todos.extractOpenItems(records);
  const text = items.map((x) => x.text).join(' || ');
  check('抽出未完成事项', items.length >= 3, `${items.length} 条`);
  check('「已经修复完毕」不被当成待办', !text.includes('登录逻辑'));
  check('「已完成：」那类不被当成待办', !text.includes('旧分片清理干净'));
  check('TODO 被归类为 todo', items.some((x) => x.kind === 'todo' && /并发数/.test(x.text)));
  check('系统注入的记录被跳过', !text.includes('Time sampled'));
  check('噪声句被跳过', !text.includes('好的，收到'));
  check('带 seq 便于回原文', items.every((x) => typeof x.seq === 'number'));

  const dupes = todos.extractOpenItems([
    rec(1, '下一步要补齐 nacos 的配置模板。'),
    rec(2, '下一步要补齐 nacos 的配置模板。'),
  ]);
  check('同一事项重复出现只留一条', dupes.length === 1, `${dupes.length} 条`);

  // 工具记录与代码块里全是「还没」「缺少」，但不能被当成待办（实测第一版抽出 31 条里大半是垃圾）
  const noisy = todos.extractOpenItems([
    { i: 1, role: 'tool-call', t: 'tool/call', tool: 'edit', ts: 1, text: '[tool/call edit] {"new_string":"还没有远端地址","old_string":"x"}' },
    { i: 2, role: 'tool-result', t: 'tool/result', tool: 'Bash', ts: 2, text: 'PASS 端到端冒烟全部通过 — 缺少的条目仍算核对不通过' },
    rec(3, '说明：\n```js\n// 还没实现\nconst x = 1;\n```\n这段就到这里。'),
    rec(4, '明白，我把发布工具收进仓并做成可迁移的，保证后续发布照常。'),
  ]);
  check('工具调用/结果里的「还没」不算待办', !noisy.some((x) => /还没有远端地址|冒烟全部通过/.test(x.text)),
    noisy.map((x) => x.text.slice(0, 30)).join(' | ') || '(空)');
  check('代码块里的「还没」不算待办', !noisy.some((x) => /还没实现/.test(x.text)));
  check('「明白，…」这类应答叙述不算待办', !noisy.some((x) => /发布工具收进仓/.test(x.text)));

  const agg = todos.aggregateOpenItems({
    sessions: [
      { card: { id: 's1', title: '甲', workspace: 'D:\\p\\DSH', app: 'dsh', updatedAt: 10 }, records: [rec(1, '待办：补单元测试')] },
      { card: { id: 's2', title: '乙', workspace: 'd-WorkBuddy-p-DSH', app: 'dsh', updatedAt: 20 }, records: [rec(2, '还没处理完时序问题')] },
      { card: { id: 's3', title: '丙', workspace: 'D:\\p\\Other', app: 'workbuddy', updatedAt: 30 }, records: null },
    ],
    perSession: 4,
    limit: 10,
  });
  check('聚合跳过没有分片的会话（同步来的）', agg.skipped === 1, `skipped=${agg.skipped}`);
  check('聚合按项目分组（同项目两种写法合一组）',
    agg.byProject.some((g) => g.project === 'DSH' && g.count === 2), agg.byProject.map((g) => `${g.project}:${g.count}`).join(', '));
  check('聚合带会话信息', agg.items.every((x) => x.sessionId && x.title && x.project));

  // 跨会话复述同一件事：只留一条，并记下「还出现在别的会话」
  const cross = todos.aggregateOpenItems({
    sessions: [
      { card: { id: 'x1', title: '旧', workspace: 'D:\\p\\DSH', app: 'dsh', updatedAt: 10 }, records: [rec(1, '下一步要补齐 nacos 的配置模板。')] },
      { card: { id: 'x2', title: '新', workspace: 'D:\\p\\DSH', app: 'dsh', updatedAt: 99 }, records: [rec(2, '下一步要补齐 nacos 的配置模板。')] },
    ],
    perSession: 5,
    limit: 10,
  });
  check('跨会话重复事项合并成一条', cross.items.length === 1 && cross.crossSessionDeduped === 1,
    `items=${cross.items.length} deduped=${cross.crossSessionDeduped}`);
  check('合并后保留较新的那个会话', cross.items[0]?.sessionId === 'x2', cross.items[0]?.sessionId);
  check('记录「还出现在别的会话」', Array.isArray(cross.items[0]?.alsoInSessions) && cross.items[0].alsoInSessions.includes('x1'),
    JSON.stringify(cross.items[0]?.alsoInSessions));
}

/* ------------------------------------------------------------ 索引体检 / 面板 API */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-v3-'));
  try {
    const cards = {
      version: 1,
      builtAt: '2026-01-01T00:00:00.000Z',
      cards: {
        a: { id: 'a', title: '甲会话', workspace: 'D:\\p\\DSH', app: 'dsh', updatedAt: Date.now(), keywords: ['插件'], decisions: ['结论'], questions: [], paths: [], files: [], tools: [], recordCount: 3 },
        b: { id: 'b', title: '乙会话', workspace: 'd-WorkBuddy-p-DSH', app: 'dsh', updatedAt: Date.now() - 1000, keywords: ['插件'], decisions: [], questions: [], paths: [], files: [], tools: [], recordCount: 1 },
        c: { id: 'c', title: '丙会话', workspace: 'D:\\p\\Other', app: 'workbuddy', updatedAt: Date.now() - 40 * 86400000, keywords: ['周报'], decisions: [], questions: [], paths: [], files: [], tools: [], recordCount: 1 },
      },
    };
    fs.writeFileSync(path.join(dir, 'cards.json'), JSON.stringify(cards));
    fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify({ version: 1, notes: [] }));

    const f = panelApi.facets(dir);
    check('facets: 应用计数', f.apps.length === 2 && f.apps.some((a) => a.app === 'dsh' && a.count === 2),
      f.apps.map((a) => `${a.app}:${a.count}`).join(', '));
    check('facets: 项目分组把同项目两种写法合并',
      f.projects.some((p) => p.project === 'DSH' && p.count === 2 && p.variantCount === 2),
      f.projects.map((p) => `${p.project}:${p.count}/${p.variantCount}`).join(', '));
    check('facets: 时间段计数（今天 / 全部）',
      f.timeRanges.find((r) => r.id === '1d').count === 2 && f.timeRanges.find((r) => r.id === 'all').count === 3,
      f.timeRanges.map((r) => `${r.id}:${r.count}`).join(', '));

    check('list 按项目名过滤（不用写全路径）',
      panelApi.listCards(dir, { workspace: 'dsh' }).total === 2,
      String(panelApi.listCards(dir, { workspace: 'dsh' }).total));
    check('list 带 project 字段', panelApi.listCards(dir, {}).items.every((i) => Boolean(i.project)));
    check('search 带 project 与命中信息',
      panelApi.searchCards(dir, { query: '插件' }).items.every((i) => i.project !== undefined));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n==== ${checks - failed}/${checks} session-index v3 checks passed ====`);
process.exit(failed === 0 ? 0 : 1);
