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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexStatus, listCards, searchCards, cardDetail, facets } from './panel-api.mjs';

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
 * 会话卡里有标题、结论、涉及路径，属于会话元数据，不能对**公网站点**敞开；
 * 但本机 DSH 的渲染进程用的是自定义 scheme（`dsh-app://`）或 `http://<本机名>:<端口>`，
 * 早先只放行 127.0.0.1/localhost 会把自家渲染进程也挡掉 → 面板一片空白、还查不出原因。
 *
 * 现在的放行范围：
 * - 没有 Origin（curl、同源请求）→ `*`；
 * - `Origin: null`（沙箱页 / data: 页）→ `*`；
 * - **非 http(s) 源**（`app://`、`dsh-app://`、`file://` …）→ 原样回显：公网网页不可能是这种源；
 * - **http(s) 源**：本机地址才算 —— 回环（127.0.0.1 / localhost / ::1）、
 *   常见本机域名后缀（.localhost / .local / .internal / .lan / .home / .test）、本机主机名。
 *   **私有网段（10.x / 192.168.x / 172.16-31.x）默认不放行**：那是局域网，
 *   局域网里的网页也能读会话卡。真需要时用环境变量单独放行。
 * - 环境变量 `SESSION_INDEX_HTTP_ALLOW_ORIGIN`（逗号分隔，或 `*` 全放行）是最终逃生舱。
 */
export function allowedOrigin(origin) {
  if (!origin || origin === 'null') return '*';
  const extra = String(process.env.SESSION_INDEX_HTTP_ALLOW_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (extra.includes('*')) return '*';
  if (extra.includes(origin)) return origin;

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return origin; // 自定义 scheme（dsh-app:// / app:// / file://）
  }
  if (isLocalHost(parsed.hostname)) return origin;
  return null;
}

/** 主机名是不是「本机」。 */
function isLocalHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
  if (host === os.hostname().toLowerCase()) return true;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')
    || host.endsWith('.lan') || host.endsWith('.home') || host.endsWith('.test')) return true;
  return false;
}

function corsHeaders(origin) {
  const allow = allowedOrigin(origin);
  const headers = {
    // Chromium 的 Private Network Access：公网源访问回环地址要显式允许。
    'Access-Control-Allow-Private-Network': 'true',
    // POST 只服务于面板的同步模块；配合下面的自定义头强制预检，
    // 远程网页连预检都过不了，也就无法用 no-cors 简单请求偷偷触发写操作。
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Session-Index-Sync',
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
 * 访问日志 + 面板自诊断落盘。
 *
 * 为什么要有：面板在**浏览器**里，它拿到的是本机数据还是「被 CORS 挡掉」，
 * 在宿主机这边完全看不见；面板显示的那句报错又常常只有一句话。
 * 有了这两个文件，「面板空白」就能在宿主机上直接定位到：
 *   - `http-access.log`  ← 面板到底请求了什么、Origin 是什么、拿到什么状态码；
 *   - `client-diagnostics.log` ← 面板自己报告的失败原因（两条通道各试了什么）。
 */
const ACCESS_LOG = 'http-access.log';
const DIAG_LOG = 'client-diagnostics.log';

function appendLog(indexDir, file, line) {
  try {
    const target = path.join(indexDir, file);
    // 超过 256 KB 就轮转一次，避免日志无限长
    try {
      const st = fs.statSync(target);
      if (st.size > 256 * 1024) fs.renameSync(target, `${target}.1`);
    } catch { /* 文件还没有 */ }
    fs.appendFileSync(target, line, 'utf8');
  } catch {
    /* 写不进去也不影响服务 */
  }
}

function logAccess(indexDir, req, url, status) {
  const origin = req.headers.origin || '-';
  const agent = String(req.headers['user-agent'] || '').slice(0, 60);
  appendLog(
    indexDir,
    ACCESS_LOG,
    `${new Date().toISOString()} ${(req.method || 'GET').toUpperCase()} ${url.pathname} origin=${origin} status=${status} ua=${agent}\n`,
  );
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
  if (p === '/api/facets') {
    const payload = facets(indexDir);
    return { code: payload.ok ? 200 : 503, body: payload };
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
      routes: [
        '/api/health', '/api/status', '/api/list?limit=60', '/api/search?q=关键词', '/api/card?id=会话id',
        'GET /api/sync/status',
        'POST /api/sync/{config|push|pull|export|import}（需 X-Session-Index-Sync 头）',
      ],
    },
  };
}

/** 读一个 JSON 请求体（上限 1 MB，超了直接拒绝）。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new SyncHttpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new SyncHttpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', () => reject(new SyncHttpError(400, '读取请求体失败')));
  });
}

class SyncHttpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * 写接口（同步模块专用）。
 * 只有 `/api/sync/*` 是写操作；调用方已在路由层校验了 Origin 与自定义头。
 * @param {string} indexDir 索引目录
 * @param {URL} url 请求 URL
 * @param {object} body JSON 请求体
 * @returns {Promise<{code:number, body:object}>}
 */
async function handleSync(indexDir, url, body) {
  const p = url.pathname;
  // 延迟 import：同步模块会拉起 git，读接口不该为它付加载成本
  const sync = await import('./sync.mjs');

  if (p === '/api/sync/status') {
    // 只读本地，不联网 —— 面板每次打开都会问
    return { code: 200, body: sync.syncStatus(indexDir) };
  }
  if (p === '/api/sync/probe') {
    // 远端探测有网络开销，单独调
    const probe = await sync.syncProbe(indexDir);
    return { code: 200, body: { ok: true, remote: probe } };
  }
  if (p === '/api/sync/config') {
    const repo = String(body.repo || '').trim();
    const branch = String(body.branch || '').trim() || 'main';
    if (body.repo !== undefined && !repo) {
      sync.saveSyncConfig({ repo: '' }, indexDir);
      return { code: 200, body: { ok: true, configured: false, status: sync.syncStatus(indexDir) } };
    }
    if (repo && !/^(git@|ssh:\/\/|https?:\/\/)/.test(repo)) {
      return { code: 400, body: { ok: false, error: '仓库地址要以 git@ / ssh:// / https:// 开头' } };
    }
    sync.saveSyncConfig({ repo, branch }, indexDir);
    return { code: 200, body: { ok: true, configured: Boolean(repo), status: sync.syncStatus(indexDir) } };
  }
  if (p === '/api/sync/push' || p === '/api/sync/pull') {
    try {
      const result = p.endsWith('/push') ? await sync.syncPush(indexDir) : await sync.syncPull(indexDir);
      return { code: 200, body: { ...result, status: sync.syncStatus(indexDir) } };
    } catch (err) {
      return {
        code: 502,
        body: { ok: false, error: (err && err.message) || String(err), hint: (err && err.hint) || '' },
      };
    }
  }
  if (p === '/api/sync/export') {
    try {
      const result = sync.exportZip(indexDir);
      return { code: 200, body: result };
    } catch (err) {
      return { code: 500, body: { ok: false, error: (err && err.message) || String(err) } };
    }
  }
  if (p === '/api/sync/import') {
    // 只允许导入「导出目录里」的包，避免借这个接口读任意路径
    const wanted = String(body.file || '');
    const exportsDir = path.join(indexDir, 'exports');
    const file = path.resolve(wanted);
    if (!file.startsWith(path.resolve(exportsDir) + path.sep)) {
      return { code: 400, body: { ok: false, error: '只支持导入 exports 目录下的 zip（先用「导出」生成）' } };
    }
    try {
      const result = sync.importZip(file, indexDir);
      return { code: 200, body: { ...result, status: sync.syncStatus(indexDir) } };
    } catch (err) {
      return { code: 500, body: { ok: false, error: (err && err.message) || String(err), hint: (err && err.hint) || '' } };
    }
  }
  return { code: 404, body: { ok: false, error: '未知同步接口', routes: ['/api/sync/status', '/api/sync/config', '/api/sync/push', '/api/sync/pull', '/api/sync/export', '/api/sync/import'] } };
}

/** 同步写接口的自定义头：强制浏览器预检，堵住 no-cors 简单请求的 CSRF。 */
export const SYNC_HEADER = 'x-session-index-sync';

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
    void (async () => {
      const method = (req.method || 'GET').toUpperCase();
      const origin = req.headers.origin;
      const allow = allowedOrigin(origin);
      let url;
      try {
        url = new URL(req.url || '/', `http://${host}`);
      } catch {
        sendJson(res, 400, { ok: false, error: 'URL 解析失败' }, origin);
        logAccess(indexDir, req, { pathname: '?' }, 400);
        return;
      }
      const isSync = url.pathname.startsWith('/api/sync/');
      const isDiag = url.pathname === '/api/diag';

      // 面板自诊断：任何源都能写（只落一行文本，不含会话数据），否则被 CORS 挡掉时
      // 面板连「自己失败了」都报不出来 —— 这一条是专门为「面板一片空白」准备的。
      if (isDiag && method === 'POST') {
        try {
          const raw = await readJsonBody(req);
          appendLog(indexDir, DIAG_LOG, `${new Date().toISOString()} ${JSON.stringify(raw).slice(0, 900)}\n`);
          logAccess(indexDir, req, url, 204);
        } catch (err) {
          logAccess(indexDir, req, url, err.code || 400);
        }
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
        return;
      }

      if (method === 'OPTIONS') {
        // 跨源头（例如渲染进程里打开的远程网页）连预检都不给过。
        if (!allow) {
          res.writeHead(403, { 'Cache-Control': 'no-store' });
          res.end();
          logAccess(indexDir, req, url, 403);
          return;
        }
        res.writeHead(204, corsHeaders(origin));
        res.end();
        logAccess(indexDir, req, url, 204);
        return;
      }

      // 同步接口（唯一会写盘 / 调 git 的一组）：Origin 放行 + 自定义头缺一不可。
      // 自定义头会让浏览器先发预检，远程网页的 no-cors 简单请求就到不了这里。
      if (isSync) {
        if (!allow) {
          sendJson(res, 403, { ok: false, error: '跨源请求被拒绝' }, origin);
          logAccess(indexDir, req, url, 403);
          return;
        }
        if (!req.headers[SYNC_HEADER]) {
          sendJson(res, 403, {
            ok: false,
            error: `缺少 ${SYNC_HEADER} 头（用于阻止网页跨站调用；面板与 curl 都会带上）`,
          }, origin);
          logAccess(indexDir, req, url, 403);
          return;
        }
        if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '同步接口只接受 GET / POST' }, origin);
          logAccess(indexDir, req, url, 405);
          return;
        }
        let body = {};
        if (method === 'POST') {
          try {
            body = await readJsonBody(req);
          } catch (err) {
            sendJson(res, err.code || 400, { ok: false, error: err.message }, origin);
            logAccess(indexDir, req, url, err.code || 400);
            return;
          }
        }
        try {
          const out = await handleSync(indexDir, url, body);
          sendJson(res, out.code, out.body, origin);
          logAccess(indexDir, req, url, out.code);
        } catch (err) {
          sendJson(res, 500, { ok: false, error: (err && err.message) || String(err) }, origin);
          logAccess(indexDir, req, url, 500);
        }
        return;
      }

      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: '只读接口只接受 GET；写操作仅限 /api/sync/*' }, origin);
        logAccess(indexDir, req, url, 405);
        return;
      }
      try {
        const { code, body } = handleRequest(indexDir, url);
        if (method === 'HEAD') {
          res.writeHead(code, { ...corsHeaders(origin), 'Content-Type': 'application/json; charset=utf-8' });
          res.end();
          logAccess(indexDir, req, url, code);
          return;
        }
        sendJson(res, code, body, origin);
        logAccess(indexDir, req, url, code);
      } catch (err) {
        sendJson(res, 500, { ok: false, error: (err && err.message) || String(err) }, origin);
        logAccess(indexDir, req, url, 500);
      }
    })().catch((err) => {
      try {
        sendJson(res, 500, { ok: false, error: (err && err.message) || String(err) }, req.headers.origin);
      } catch {
        /* 响应已发出或连接已断 */
      }
    });
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
