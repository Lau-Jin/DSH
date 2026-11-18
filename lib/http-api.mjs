/**
 * 本地只读 HTTP API —— 侧栏「会话检索」面板的**主数据通道**。
 *
 * 为什么要有它：
 *   面板是浏览器半身，读不了文件系统；原来的通道是 gateway 的 `commands/execute`，
 *   而它是**按 agent 作用域**的（wire 字段 agentId，类型 SessionId）：
 *   - 面板必须先「借」一个活的会话 id，命令才会被寻址；
 *   - 会话被归档/移除/壳重载时，id 失效 → 面板整片取不到数；
 *   - 宿主半身那一行没加载时（bundle 行名与安装目录不一致就会这样），
 *     面板只能报一句「宿主半身没加载」，人无从下手。
 *
 * 这个 HTTP 通道由 **MCP 服务进程**自己开（server.mjs 启动时调用），
 * 于是面板和 agent 用的是**同一份索引、同一套查询实现**（lib/panel-api.mjs），
 * 谁都不需要借会话，也不再依赖宿主半身。
 *
 * 安全边界：
 * - 只绑 127.0.0.1，只接受 GET/HEAD/OPTIONS，没有任何写接口；
 * - 只读 cards.json（会话卡：标题、结论、关键词、涉及路径），不返回会话原文；
 * - CORS 按源判定（`allowedOrigin`）：远程 http(s) 网站一律不给跨源头，
 *   本地源（回环、file://、app:// 等）放行 —— 防的是「渲染进程里打开的远程网页
 *   借浏览器读回环接口」；本地进程本来就能直接读索引文件，不在威胁模型里。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexStatus, listCards, searchCards, cardDetail } from './panel-api.mjs';

/** 面板会依次尝试的端口（第一个可用者胜出）。 */
export const DEFAULT_PORTS = [8799, 8800, 8801, 8802, 8803, 8804, 8805, 8806, 8807, 8808];

/** 服务名与版本：版本取 package.json，避免多处硬编码（发布改名时也只改一处）。 */
const PKG = (() => {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { name: String(pkg.name || 'dsh-session-index'), version: String(pkg.version || '0.0.0') };
  } catch {
    return { name: 'dsh-session-index', version: '0.0.0' };
  }
})();

/**
 * 判断一个 `Origin` 头能不能读本接口，返回该回给浏览器的值（null = 不给跨源头）。
 *
 * 会话卡里有标题、结论、涉及路径，属于会话元数据，不能对全网敞开：
 * - 没有 Origin（curl、同源请求）→ `*`；
 * - `Origin: null`（file:// 沙箱页、data: 页）→ `*`（不可信源拿不到响应体之外的东西，
 *   而且 DSH 渲染进程本身就可能报 `null`）；
 * - **非 http(s) 源**（`app://`、`dsh://`、`file://` 等）→ 原样回显：远程网页永远是
 *   http(s) 源，不可能是这些，所以放行不影响「防远程页面偷读」这个目标；
 * - **http(s) 源** → 只放行回环（127.0.0.1 / localhost / [::1]），远程站点一律不给头。
 *
 * 本地进程本来就能直接读 `~/.dsh/session-index/cards.json`，所以这条规则防的是
 * 「渲染进程里打开的远程网页借浏览器读回环接口」。
 */
export function allowedOrigin(origin) {
  if (!origin || origin === 'null') return '*';
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    const host = parsed.hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1' ? origin : null;
  }
  return origin;
}

function corsHeaders(origin) {
  const allow = allowedOrigin(origin);
  const headers = {
    // Chromium 的 Private Network Access：公网源访问回环地址要显式允许。
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };
  if (allow) headers['Access-Control-Allow-Origin'] = allow;
  return headers;
}

function sendJson(res, code, body, origin) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    ...corsHeaders(origin),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readIndexDir() {
  const dir = process.env.SESSION_INDEX_DIR
    || path.join(process.env.DSH_HOME || '', 'session-index')
    || '';
  return dir;
}

/**
 * 处理一条 HTTP 请求。
 * @param {string} indexDir 索引目录
 * @param {URL} url 请求 URL
 * @returns {{code: number, body: object}}
 */
export function handleRequest(indexDir, url) {
  const p = url.pathname;
  if (p === '/api/health' || p === '/api/ping') {
    return { code: 200, body: { ok: true, service: PKG.name, version: PKG.version } };
  }
  if (p === '/api/status') {
    return { code: 200, body: indexStatus(indexDir, { channel: 'http' }) };
  }
  if (p === '/api/list') {
    const limit = Number(url.searchParams.get('limit')) || 60;
    const payload = listCards(indexDir, {
      limit,
      app: url.searchParams.get('app') || 'all',
      workspace: url.searchParams.get('workspace') || '',
    });
    return { code: payload.ok ? 200 : 503, body: payload };
  }
  if (p === '/api/search') {
    const query = url.searchParams.get('q') || url.searchParams.get('query') || '';
    const payload = searchCards(indexDir, {
      query,
      limit: Number(url.searchParams.get('limit')) || 40,
      app: url.searchParams.get('app') || 'all',
      workspace: url.searchParams.get('workspace') || '',
    });
    return { code: payload.ok ? 200 : 400, body: payload };
  }
  if (p === '/api/card') {
    const id = url.searchParams.get('id') || '';
    const payload = cardDetail(indexDir, { id });
    return { code: payload.ok ? 200 : 404, body: payload };
  }
  return {
    code: 404,
    body: {
      ok: false,
      error: '未知接口',
      routes: ['/api/health', '/api/status', '/api/list?limit=60', '/api/search?q=关键词', '/api/card?id=会话id'],
    },
  };
}

/**
 * 启动本地只读 HTTP 服务。
 *
 * 端口占用就往后试；全占就返回 null（**绝不影响 MCP 服务本身**）。
 *
 * @param {{indexDir?: string, ports?: number[], host?: string, log?: Function}} [options]
 * @returns {{server: import('node:http').Server, port: number, url: string} | null}
 */
export function startPanelHttp(options = {}) {
  const indexDir = options.indexDir || readIndexDir();
  const host = options.host || '127.0.0.1';
  const log = typeof options.log === 'function' ? options.log : () => {};
  const ports = Array.isArray(options.ports) && options.ports.length ? options.ports : DEFAULT_PORTS;

  if (!indexDir) {
    log('面板 HTTP 通道未启用：找不到索引目录');
    return null;
  }

  const server = http.createServer((req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    const origin = req.headers.origin;
    const allow = allowedOrigin(origin);
    if (method === 'OPTIONS') {
      // 跨源头（例如渲染进程里打开的远程网页）连预检都不给过。
      if (!allow) {
        res.writeHead(403, { 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      res.writeHead(204, corsHeaders(origin));
      res.end();
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: '只读接口，只接受 GET' }, origin);
      return;
    }
    let url;
    try {
      url = new URL(req.url || '/', `http://${host}`);
    } catch {
      sendJson(res, 400, { ok: false, error: 'URL 解析失败' }, origin);
      return;
    }
    try {
      const { code, body } = handleRequest(indexDir, url);
      if (method === 'HEAD') {
        res.writeHead(code, { ...corsHeaders(origin), 'Content-Type': 'application/json; charset=utf-8' });
        res.end();
        return;
      }
      sendJson(res, code, body, origin);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: (err && err.message) || String(err) }, origin);
    }
  });

  // 端口占用就顺延；全占则放弃（返回 null），MCP 服务照常工作。
  let index = 0;
  const tryListen = () => {
    if (index >= ports.length) {
      log('面板 HTTP 通道未启用：端口都被占用');
      return;
    }
    const port = ports[index++];
    server.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        tryListen();
        return;
      }
      log('面板 HTTP 通道出错：' + ((err && err.message) || err));
    });
    server.listen(port, host, () => {
      const url = `http://${host}:${port}`;
      log(`面板 HTTP 通道已就绪：${url}`);
      try {
        const file = path.join(indexDir, 'http-url.txt');
        fs.writeFileSync(file, url + '\n', 'utf8');
      } catch {
        /* 写不进去也不影响服务 */
      }
    });
  };
  tryListen();

  return { server, port: ports[0], url: `http://${host}:${ports[0]}` };
}
