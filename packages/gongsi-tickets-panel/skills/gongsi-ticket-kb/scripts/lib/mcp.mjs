/**
 * gongsi MCP 客户端公共库（streamable-http）。
 *
 * 连接信息读取顺序：
 *   1. 环境变量 GONGSI_MCP_URL / GONGSI_MCP_TOKEN
 *   2. DSH profile 补丁 ~/.dsh/profiles/<profile>/cordis.patch.yml 的 mcp-gongsi 段
 *
 * ⚠️ 只用于**只读**排查脚本。写操作（回写工单/记工时/完成工单）必须走
 *    工具层并遵守 SKILL.md 铁律 6「先确认再写」—— 脚本层没有那道人工闸门。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function loadProfile() {
  const profileDir = process.env.DSH_PROFILE || 'desktop';
  const file = path.join(os.homedir(), '.dsh', 'profiles', profileDir, 'cordis.patch.yml');
  if (!fs.existsSync(file)) return {};
  const txt = fs.readFileSync(file, 'utf8');
  const m = txt.match(/- id:\s*mcp-gongsi[\s\S]*?(?=\n- id:|\n*$)/);
  const seg = m ? m[0] : txt;
  return {
    url: (seg.match(/url:\s*(\S+)/) || [])[1],
    auth: (seg.match(/Authorization:\s*['"]?([^'"\n]+)['"]?/) || [])[1],
  };
}

const prof = loadProfile();
export const ENDPOINT = process.env.GONGSI_MCP_URL || prof.url || 'https://yanfa.scedu.tech/api/mcp';
const RAW_TOKEN = process.env.GONGSI_MCP_TOKEN || prof.auth || '';
export const TOKEN = /^bearer\s/i.test(RAW_TOKEN) ? RAW_TOKEN : `Bearer ${RAW_TOKEN}`;

let sessionId = null;

function headers(extra = {}) {
  const h = {
    Authorization: TOKEN,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-06-18',
    ...extra,
  };
  if (sessionId) h['Mcp-Session-Id'] = sessionId;
  return h;
}

// 服务端可能回纯 JSON，也可能回 SSE（text/event-stream）
function parseBody(buf, contentType) {
  const text = buf.toString('utf8');
  if (contentType && contentType.includes('text/event-stream')) {
    const events = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      if (data) {
        try {
          events.push(JSON.parse(data));
        } catch {
          /* 跳过非 JSON 帧 */
        }
      }
    }
    return events;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 4000) };
  }
}

async function post(body) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, body: parseBody(buf, res.headers.get('content-type')) };
}

export async function init() {
  const r = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dsh-gongsi-ticket-kb', version: '1.0.5' },
    },
  });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return r;
}

function unwrap(result) {
  const frames = Array.isArray(result.body) ? result.body : [result.body];
  for (const f of frames) {
    if (f && f.result) return f.result;
    if (f && f.error) return { error: f.error };
  }
  return { raw: result.text, status: result.status };
}

/** 调一个 gongsi 工具，返回结构化结果对象（structuredContent 优先）。 */
export async function callTool(name, args) {
  const r = await post({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name, arguments: args ?? {} },
  });
  const res = unwrap(r);
  if (res && res.error) {
    throw new Error(`${name} 失败: ${JSON.stringify(res.error)}`);
  }
  if (r.status !== 200) {
    throw new Error(`${name} HTTP ${r.status}`);
  }
  const data = res.structuredContent ?? safeParse(res.content?.[0]?.text);

  // ⚠️ 工具层错误：MCP 会用 isError:true + text 内容返回，**不是** JSON-RPC 层 error。
  //    不显式判掉的话，错误信封会被当成正常数据返回，调用方看到的是"0 条命中"，
  //    而真实原因是"响应体超预算" —— 会把人带进"KB 没查到"的错误结论。
  if (res.isError === true) {
    const msg = typeof res.content?.[0]?.text === 'string' ? res.content[0].text : JSON.stringify(res);
    throw new Error(`${name} 失败: ${msg}`);
  }
  if (data && typeof data === 'object' && data.code !== undefined && data.message !== undefined) {
    throw new Error(`${name} 失败: ${JSON.stringify(data)}`);
  }
  return data;
}

function safeParse(t) {
  if (typeof t !== 'string') return t;
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t };
  }
}

/** 顺序调用多个工具，任一失败即抛错。 */
export async function callMany(calls) {
  await init();
  const out = [];
  for (const c of calls) {
    out.push({ tool: c.tool, args: c.args, data: await callTool(c.tool, c.args) });
  }
  return out;
}

/** 把长文本压成一行摘要，用于控制上下文体积。 */
export function oneLine(s, max = 220) {
  if (s == null) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/**
 * 顶层错误出口。
 *
 * 目的：**失败必须是响的，而且必须好认。**
 * 退出码约定（各脚本统一）：
 *   0 = 成功 / 预检通过 / 体积达标
 *   1 = 业务性不通过（预检不通过、体积超标）
 *   2 = 用法错误（参数不对）
 *   3 = 脚本内部错误（网络、鉴权、服务端异常）
 * 用 3 而不是 1，是为了让调用方能区分"结论是不行"和"没跑成"。
 */
export function fatal(err) {
  const msg = err && err.message ? err.message : String(err);
  // 写 stdout 而不是 stderr：调用方只看标准输出时也必须看得见失败
  console.log(`\n❌ ${msg}`);
  console.log(`❌ 脚本未能完成，退出码 3 —— 这不是"查到了空结果"，不要当成结论用。\n`);
  process.exit(3);
}

/** 挂上顶层错误捕获：未处理的 promise 拒绝 → fatal，而不是甩 Node 栈。 */
export function guard() {
  process.on('unhandledRejection', fatal);
  process.on('uncaughtException', fatal);
}

/**
 * 并发调用多个工具。
 *   strict=true  （默认）任一失败即抛
 *   strict=false 任一失败都**不抛**，失败项带 error 字段返回
 *
 * ⚠️ strict=false 的用途：批量取原文时，一个分片取不到（比如无权限）不该让
 *    整份引用块作废 —— 那一项标注成"取不到"继续出结果。
 */
export async function callToolsParallel(calls, { strict = true } = {}) {
  const res = await Promise.all(
    calls.map(async (c) => {
      try {
        return { ...c, data: await callTool(c.tool, c.args) };
      } catch (e) {
        return { ...c, error: e.message };
      }
    })
  );
  if (strict) {
    const bad = res.find((r) => r.error);
    if (bad) throw new Error(`${bad.tool} 失败: ${bad.error}`);
  }
  return res;
}

export const T0 = Date.now();
export function elapsed() {
  return `${Date.now() - T0}ms`;
}

/**
 * 收集所有检索式。
 *   --query "A" --query "B"    重复使用
 *   --queries "A" "B" "C"       一次给多个
 * 多个检索式会被**并发**执行（串行 3 次 ≈5.1s，并发 ≈2.0s）。
 */
export function collectQueries(argv) {
  const qs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--query' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      qs.push(argv[++i]);
    } else if (argv[i] === '--queries') {
      let j = i + 1;
      while (j < argv.length && !argv[j].startsWith('--')) qs.push(argv[j++]);
      i = j - 1;
    }
  }
  return qs;
}
