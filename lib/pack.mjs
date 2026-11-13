/**
 * 零依赖打包器：把插件 / 技能打成可直接分发的 zip，无需手工压缩。
 *
 * 只用 Node 内置模块实现最小 ZIP writer（DEFLATE + CRC32 + 中央目录），
 * 不引入 archiver / jszip 等第三方依赖。
 *
 * 模式：
 *   plugin  完整插件包（源码 + 清单 + 文档 + Skill + 安装说明）
 *   skill   仅技能包（根 SKILL.md + 说明），可直接导入 DSH「MCP 与技能」
 *   all     一次生成以上两种
 *
 * 隐私：索引产物、长期记忆、备份、临时文件、已有 zip 一律排除。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.join(PLUGIN_DIR, 'dist');

const EXCLUDE = /(\.bak-|\.tmp-|\.jsonl\.gz$|^notes\.json$|^meta\.json$|^cards\.json$|^vectors\.json$|\.zip$|\.lock$|^\.git\/|^node_modules\/|^dist\/|^\.workbuddy\/|^_verify)/i;
const ALLOWED_EXT = /\.(mjs|json|md|html|txt|yml|yaml|cmd|bat|sh|ps1)$/i;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const dosTime = (d) => (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
const dosDate = (d) => ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

/** @param {Array<{name:string,data:Buffer|string}>} entries */
export function createZip(entries) {
  const now = new Date();
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 6 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime(now), 10);
    lh.writeUInt16LE(dosDate(now), 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    localChunks.push(lh, name, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(dosTime(now), 12);
    ch.writeUInt16LE(dosDate(now), 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centralChunks.push(ch, name);

    offset += lh.length + name.length + body.length;
  }
  const central = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localChunks, central, eocd]);
}

/** 读取 ZIP 尾部信息并逐项校验中央目录，返回包内文件名。 */
export function inspectZip(file) {
  const b = fs.readFileSync(file);
  let i = b.length - 22;
  while (i >= 0 && b.readUInt32LE(i) !== 0x06054b50) i -= 1;
  if (i < 0) throw new Error('不是有效 zip（未找到 EOCD）');
  const count = b.readUInt16LE(i + 10);
  const centralSize = b.readUInt32LE(i + 12);
  const centralOffset = b.readUInt32LE(i + 16);
  const names = [];
  let p = centralOffset;
  for (let n = 0; n < count; n++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error(`中央目录第 ${n + 1} 项损坏`);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    names.push(b.slice(p + 46, p + 46 + nameLen).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (p - centralOffset !== centralSize) throw new Error('中央目录长度不匹配');
  return { ok: true, count, names, bytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') };
}

function walk(dir, base = '', out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (rel === 'dist' || rel === 'node_modules' || rel === '.git' || rel === '.workbuddy') continue;
      walk(full, rel, out);
    } else if (entry.isFile()) {
      if (EXCLUDE.test(rel) || !ALLOWED_EXT.test(rel)) continue;
      out.push({ name: rel, full });
    }
  }
  return out;
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function installDoc(version) {
  return [
    `# dsh-session-index v${version} 安装说明`,
    '',
    '## 方式一：解压后一键安装（推荐）',
    '',
    'Windows 双击 `install.cmd`；或在本目录执行：',
    '',
    '```bash',
    'node install.mjs',
    '```',
    '',
    '## 方式二：从 GitHub 仓库拉取（可随仓库更新）',
    '',
    '```bash',
    'git clone git@github.com:Lau-Jin/DSH.git',
    'cd DSH',
    'install.cmd',
    '```',
    '',
    '安装器会自动：解析 Node >= 22.15、写入 DSH 的 MCP 配置（写前备份）、安装 Skill、',
    '开启后台自动建索引与自动增量刷新，并生成本插件/技能的分发包。',
    '重复安装（含更新后重跑）会保留你在配置块里手工改过的 env 值。',
    '',
    '若 DSH 正在运行，配置会热生效；工具列表未刷新时完全退出 DSH 再打开。',
    '之后新会话由文件事件自动识别，不需要重启 DSH。',
    '',
    '校验：`node install.mjs --verify`　回滚：`node install.mjs --uninstall`',
    '',
    '要求：Node >= 22.15（需要 zlib.zstdDecompressSync）。',
    '注意：包内不含任何会话数据、索引或密钥，可安全分发。',
  ].join('\n');
}

function skillDoc(version) {
  return [
    `# session-index 技能 v${version}`,
    '',
    '本包只含 SKILL.md，可直接导入 DSH「MCP 与技能」→ Skills，',
    '或解压到 `%USERPROFILE%\\.dsh\\skills\\session-index\\SKILL.md`。',
    '',
    '前置：需同时启用 `session-index` MCP server（运行完整插件包里的 `node install.mjs`）。',
    '技能作用：引导 Agent 在会话开始或提到「之前 / 上次 / 继续」时主动调用',
    '`session_index_brief`，接上全部历史会话结论与长期记忆。',
  ].join('\n');
}

/**
 * 生成一个包。
 * @param {{mode?:string, outDir?:string, version?:string}} options
 */
export function pack({ mode = 'plugin', outDir = DEFAULT_OUT, version } = {}) {
  if (!['plugin', 'skill'].includes(mode)) throw new Error(`未知打包模式: ${mode}`);
  const ver = version || readVersion();
  fs.mkdirSync(outDir, { recursive: true });
  const builtAt = new Date().toISOString();
  let files = [];
  let name;

  if (mode === 'plugin') {
    files = walk(PLUGIN_DIR).map((f) => ({ name: f.name, data: fs.readFileSync(f.full) }));
    name = `dsh-session-index-v${ver}.zip`;
    files.push({ name: 'INSTALL.md', data: installDoc(ver) });
  } else {
    const skill = fs.readFileSync(path.join(PLUGIN_DIR, 'skill', 'SKILL.md'));
    files = [
      { name: 'SKILL.md', data: skill },
      { name: 'README.md', data: skillDoc(ver) },
    ];
    name = `session-index-skill-v${ver}.zip`;
  }

  const manifest = {
    name: 'dsh-session-index',
    version: ver,
    mode,
    builtAt,
    generator: 'lib/pack.mjs (zero dependency)',
    requires: { node: '>=22.15' },
    install: mode === 'plugin' ? 'node install.mjs' : '导入 DSH 技能管理器',
    excludes: ['索引产物 *.jsonl.gz', 'meta/cards/notes/vectors.json', '备份与临时文件', '已有 zip'],
    files: files
      .map((f) => ({
        name: f.name,
        bytes: f.data.length,
        sha256: crypto.createHash('sha256').update(f.data).digest('hex').slice(0, 16),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
  files.push({ name: 'MANIFEST.json', data: JSON.stringify(manifest, null, 2) });

  const zip = createZip(files);
  const out = path.join(outDir, name);
  fs.writeFileSync(out, zip);
  const info = inspectZip(out);
  return {
    ok: true,
    mode,
    version: ver,
    path: out,
    bytes: zip.length,
    sha256: info.sha256.slice(0, 16),
    fileCount: info.count,
    includes: manifest.files.slice(0, 8).map((f) => f.name),
    builtAt,
  };
}

/** 一次生成插件包 + 技能包。 */
export function packAll(options = {}) {
  return [pack({ ...options, mode: 'plugin' }), pack({ ...options, mode: 'skill' })];
}

/** 列出 dist 中已生成的包，供资源 session-index://package 使用。 */
export function listPacks(outDir = DEFAULT_OUT) {
  if (!fs.existsSync(outDir)) return { packs: [], outDir };
  const packs = fs
    .readdirSync(outDir)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => {
      const p = path.join(outDir, f);
      try {
        const info = inspectZip(p);
        return { name: f, path: p, bytes: info.bytes, fileCount: info.count, mtime: fs.statSync(p).mtime.toISOString(), valid: true };
      } catch (e) {
        return { name: f, path: p, valid: false, error: e.message };
      }
    })
    .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  return { outDir, packs };
}

export function defaultOutDir() {
  return DEFAULT_OUT;
}
