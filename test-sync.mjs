/**
 * 跨终端同步（lib/sync.mjs + /api/sync/*）单测。
 *
 * 全程在临时目录里跑：用 `git init --bare` 当「另一台终端」的远端，
 * 造两份独立索引 A / B 来回推拉，**绝不碰真实 ~/.dsh/session-index**，
 * 也不需要网络（远端就是本地目录）。
 *
 * 覆盖：合并语义（union、取新、记忆去重）→ 导出/导入 zip →
 * A 推 → B 拉 → B 推 → A 拉（双向合并不丢数据）→
 * HTTP 层的 Origin 与自定义头防护。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const sync = await import(pathToFileURL(path.join(ROOT, 'lib', 'sync.mjs')).href);
const { startPanelHttp, SYNC_HEADER } = await import(pathToFileURL(path.join(ROOT, 'lib', 'http-api.mjs')).href);

let checks = 0;
let failed = 0;
function check(name, ok, extra) {
  checks += 1;
  if (ok) console.log('  PASS ' + name + (extra ? ' | ' + extra : ''));
  else { failed += 1; console.log('  FAIL ' + name + (extra ? ' | ' + extra : '')); }
}

const work = mkdtempSync(path.join(tmpdir(), 'si-sync-'));
const cleanup = [];
try {
  /* ------------------------------------------------------------ 合并语义 */
  const card = (id, updatedAt, title) => ({ id, title, updatedAt, keywords: [], decisions: [], questions: [], paths: [] });

  const merged = sync.mergeCards(
    { builtAt: '2026-01-01T00:00:00.000Z', cards: { a: card('a', 100, '本地旧'), b: card('b', 300, '本地独有') } },
    { builtAt: '2026-01-02T00:00:00.000Z', cards: { a: card('a', 200, '远端新'), c: card('c', 150, '远端独有') } },
  );
  check('合并 cards：同 id 取更新的', merged.doc.cards.a.title === '远端新', merged.doc.cards.a.title);
  check('合并 cards：两边独有都保留', merged.doc.cards.b && merged.doc.cards.c && merged.total === 3, `total=${merged.total}`);
  check('合并 cards：计数正确（远端新增 1、同 id 更新 1）', merged.added === 1 && merged.updated === 1 && merged.unchanged === 0,
    `added=${merged.added} updated=${merged.updated}`);
  check('合并 cards：builtAt 取较新', merged.doc.builtAt === '2026-01-02T00:00:00.000Z', merged.doc.builtAt);

  const localNotes = {
    version: 1,
    notes: [
      { id: 'n1', type: 'fact', text: '同一件事', tags: ['a'], importance: 3, updatedAt: 10 },
      { id: 'n2', type: 'fact', text: '本地独有', importance: 3, updatedAt: 10 },
    ],
  };
  const remoteNotes = {
    version: 1,
    notes: [
      { id: 'n9', type: 'fact', text: '同一件事', tags: ['b'], importance: 5, updatedAt: 99 },
      { id: 'n1', type: 'fact', text: '同一件事', tags: ['c'], importance: 2, updatedAt: 5 },
    ],
  };
  const mergedNotes = sync.mergeNotes(localNotes, remoteNotes);
  const mergedOne = mergedNotes.doc.notes.find((n) => n.text === '同一件事');
  check('合并记忆：同文本跨机器只留一条', mergedNotes.total === 2, `total=${mergedNotes.total}`);
  check('合并记忆：取更新的那份内容', Boolean(mergedOne) && mergedOne.importance === 5, String(mergedOne && mergedOne.importance));
  check('合并记忆：标签取并集', Boolean(mergedOne) && ['a', 'b', 'c'].every((t) => mergedOne.tags.includes(t)),
    mergedOne && mergedOne.tags.join(','));
  check('合并记忆：保留先见到的 id（本机的）', Boolean(mergedOne) && mergedOne.id === 'n1', mergedOne && mergedOne.id);
  check('合并记忆：本地独有保留', Boolean(mergedNotes.doc.notes.find((n) => n.id === 'n2')));

  /* ------------------------------------------------------------ 临时索引 */
  const mkIndex = (cards, notes) => {
    const dir = mkdtempSync(path.join(work, 'idx-'));
    cleanup.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'cards.json'), JSON.stringify({ version: 1, builtAt: '2026-01-05T00:00:00.000Z', cards }));
    writeFileSync(path.join(dir, 'notes.json'), JSON.stringify({ version: 1, updatedAt: null, notes }));
    return dir;
  };

  const indexA = mkIndex(
    { 'sess-a1': card('sess-a1', 500, 'A 的会话一'), 'sess-shared': card('sess-shared', 100, '共享（A 旧）') },
    [{ id: 'note-a', type: 'decision', text: 'A 的结论', importance: 4, updatedAt: 50 }],
  );
  const indexB = mkIndex(
    { 'sess-b1': card('sess-b1', 600, 'B 的会话一'), 'sess-shared': card('sess-shared', 200, '共享（B 新）') },
    [{ id: 'note-b', type: 'fact', text: 'B 的事实', importance: 3, updatedAt: 60 }],
  );

  // 「另一台终端」= 一个本地裸仓
  const bare = path.join(work, 'remote.git');
  cleanup.push(bare);
  const { execFileSync } = await import('node:child_process');
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '--bare', '--initial-branch=main', bare]);

  check('git 可用（同步的前置）', sync.gitAvailable());

  /* ------------------------------------------------------------ A 推 */
  sync.saveSyncConfig({ repo: bare, branch: 'main' }, indexA);
  const pushA = sync.syncPush(indexA);
  check('A 首次推送成功', pushA.ok && pushA.changed === true, `commit=${pushA.commit}`);
  check('A 推送内容计数', pushA.cards === 2 && pushA.notes === 1, `cards=${pushA.cards} notes=${pushA.notes}`);
  const remoteCards = JSON.parse(git(['show', 'main:cards.json'], bare));
  check('远端拿到了 A 的会话卡', Object.keys(remoteCards.cards).length === 2, `n=${Object.keys(remoteCards.cards).length}`);
  const manifest = JSON.parse(git(['show', 'main:manifest.json'], bare));
  check('远端 manifest 记了机器与条数', manifest.machine && manifest.cards === 2, `${manifest.machine}/${manifest.cards}`);

  /* ------------------------------------------------------------ B 拉 */
  sync.saveSyncConfig({ repo: bare, branch: 'main' }, indexB);
  const pullB = sync.syncPull(indexB);
  check('B 拉取成功', pullB.ok, `added=${pullB.added}`);
  check('B 拿到了 A 的会话卡', pullB.added === 1, `added=${pullB.added}`);
  const bCards = JSON.parse(readFileSync(path.join(indexB, 'cards.json'), 'utf8'));
  check('B 的本地卡仍在', Boolean(bCards.cards['sess-b1']));
  check('B 的共享卡取了较新的那份（B 自己的）', bCards.cards['sess-shared'].title === '共享（B 新）',
    bCards.cards['sess-shared'].title);
  const bNotes = JSON.parse(readFileSync(path.join(indexB, 'notes.json'), 'utf8'));
  check('B 的记忆合并了 A 的', bNotes.notes.length === 2, `n=${bNotes.notes.length}`);

  /* ------------------------------------------------------------ B 改完推 → A 拉 */
  bCards.cards['sess-b2'] = card('sess-b2', 700, 'B 的新会话');
  bCards.cards['sess-shared'].title = '共享（B 更新）';
  writeFileSync(path.join(indexB, 'cards.json'), JSON.stringify(bCards));
  const pushB = sync.syncPush(indexB);
  check('B 推送成功', pushB.ok && pushB.changed, `commit=${pushB.commit}`);

  const pullA = sync.syncPull(indexA);
  const aCards = JSON.parse(readFileSync(path.join(indexA, 'cards.json'), 'utf8'));
  check('A 拉回了 B 的新会话', Boolean(aCards.cards['sess-b2']));
  check('A 的会话卡没被覆盖丢失', Boolean(aCards.cards['sess-a1']));
  check('A 的共享卡更新为最新', aCards.cards['sess-shared'].title === '共享（B 更新）', aCards.cards['sess-shared'].title);
  check('A 拉取报告了新增数', pullA.added >= 1, `added=${pullA.added}`);

  const again = sync.syncPush(indexA);
  check('重复推送是幂等的（无变化）', again.ok && again.changed === false, `changed=${again.changed}`);

  /* ------------------------------------------------------------ 导出 / 导入 */
  const zip = sync.exportZip(indexA);
  check('导出 zip 成功', zip.ok && existsSync(zip.file) && zip.bytes > 0, `${zip.bytes}B`);
  const entries = sync.readZip(zip.file);
  check('zip 里有 cards/notes/manifest/README',
    ['cards.json', 'notes.json', 'manifest.json', 'README.txt'].every((k) => Boolean(entries[k])),
    Object.keys(entries).join(','));

  const indexC = mkIndex({}, []);
  const imported = sync.importZip(zip.file, indexC);
  check('导入到空索引', imported.ok && imported.added === 4, `added=${imported.added}`);
  const cCards = JSON.parse(readFileSync(path.join(indexC, 'cards.json'), 'utf8'));
  check('导入后是合并不是覆盖', Object.keys(cCards.cards).length === 4, `n=${Object.keys(cCards.cards).length}`);

  /* ------------------------------------------------------------ 状态 */
  const statusA = sync.syncStatus(indexA);
  check('状态：已配置 + 本地计数', statusA.configured && statusA.local.cards === 4, `cards=${statusA.local.cards}`);
  check('状态：能看到远端 manifest', Boolean(statusA.remote && statusA.remote.ok && statusA.remote.manifest),
    statusA.remote && statusA.remote.manifest ? String(statusA.remote.manifest.cards) : 'null');
  const unconfigured = sync.syncStatus(mkdtempSync(path.join(work, 'idx-none-')));
  check('状态：未配置时给出原因', unconfigured.configured === false && Boolean(unconfigured.reason), unconfigured.reason);

  /* ------------------------------------------------------------ HTTP 层防护 */
  const srv = startPanelHttp({ indexDir: indexA, ports: [8931, 8932, 8933], log: () => {} });
  let base = null;
  if (srv) {
    for (let i = 0; i < 40 && !srv.server.listening; i += 1) await new Promise((r) => setTimeout(r, 25));
    const addr = srv.server.address();
    if (addr && addr.port) base = `http://127.0.0.1:${addr.port}`;
  }
  check('同步 HTTP 服务能起来', Boolean(base), String(base));

  if (base) {
    const headers = { 'Content-Type': 'application/json', [SYNC_HEADER]: '1' };

    const noHeader = await fetch(base + '/api/sync/status');
    check('缺自定义头被拒（堵 no-cors CSRF）', noHeader.status === 403, String(noHeader.status));

    const withHeader = await fetch(base + '/api/sync/status', { headers });
    const statusBody = await withHeader.json();
    check('带头的 status 可读', withHeader.ok && statusBody.configured === true, `cards=${statusBody.local?.cards}`);

    const foreign = await fetch(base + '/api/sync/status', { headers: { ...headers, Origin: 'https://evil.example.com' } });
    check('远程 Origin 被拒', foreign.status === 403, String(foreign.status));

    const badRepo = await fetch(base + '/api/sync/config', {
      method: 'POST', headers, body: JSON.stringify({ repo: 'not-a-url' }),
    });
    check('非法仓库地址被拒', badRepo.status === 400, String(badRepo.status));

    const exportRes = await fetch(base + '/api/sync/export', { method: 'POST', headers, body: '{}' });
    const exportBody = await exportRes.json();
    check('HTTP 导出可用', exportRes.ok && exportBody.ok && existsSync(exportBody.file), exportBody.file && path.basename(exportBody.file));

    const badImport = await fetch(base + '/api/sync/import', {
      method: 'POST', headers, body: JSON.stringify({ file: 'C:/Windows/win.ini' }),
    });
    check('导入拒绝 exports 之外的路径', badImport.status === 400, String(badImport.status));

    const readOnly = await fetch(base + '/api/list?limit=1', { method: 'POST', headers });
    check('非同步接口仍然只读', readOnly.status === 405, String(readOnly.status));

    await new Promise((r) => srv.server.close(r));
  }
} finally {
  for (const dir of cleanup) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清不掉不影响结论 */
    }
  }
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* 同上 */
  }
}

console.log(`\n==== ${checks - failed}/${checks} session-index sync checks passed ====`);
process.exit(failed === 0 ? 0 : 1);
