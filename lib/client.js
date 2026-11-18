/**
 * dsh-session-index · 浏览器半身（DSH 面板）。
 *
 * 做一件事：把本机会话索引**可视化**——搜索框 + 会话卡列表 + 右侧详情
 * （结论 / 提问 / 涉及路径 / 关键词），点一张卡就能翻到那次会话都定了什么。
 *
 * 数据通道（浏览器读不了文件系统，必须问）：
 *   1. **本地只读 HTTP（首选）**：MCP 服务进程自己开的 `127.0.0.1:8799`（占用就顺延），
 *      与 agent 用同一份索引、同一套查询实现。不需要会话，也不依赖宿主半身那一行。
 *   2. **gateway 命令通道（兜底）**：`ctx.remote.commands.execute(sessionId, line, [])`，
 *      按 agent 作用域寻址，必须借一个活的会话 id；宿主半身没加载时走不通。
 *
 * 约束：工厂里不许有副作用；定时器、样式、监听都放进 apply 用 ctx.effect 挂。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-index',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const { createElement: h, useState, useEffect, useMemo, useCallback } = React;

    const NS = 'sessionIndex';
    const PANEL_ID = 'session-index';
    const inject = ['slots', 'locale', 'remote', 'remote.commands'];

    const DICT = {
      zh: {
        panel: '会话检索',
        search: '搜索会话…',
        searchHint: '按标题 / 结论 / 关键词 / 路径搜',
        refresh: '刷新',
        status: '索引状态',
        loading: '加载中…',
        empty: '还没有会话卡。等索引建好（首次约 1 分钟）再回来。',
        noHit: '没有命中的会话。',
        hostUnavailable: '宿主半身没加载：会话检索面板取不到数。重启 DSH 或重新安装 dsh-session-index 后再试。',
        noSession: '面板要借一个会话的作用域读索引（命令通道按 agent 寻址），当前没有可用会话：请先打开或新建一个会话，再回来。',
        channelHttp: 'HTTP',
        channelCommand: '命令通道',
        bothFailed: '两条数据通道都不通：本地 HTTP 通道（MCP 服务进程开的，127.0.0.1:8799 起）没响应，命令通道也拿不到可用会话。请确认 DSH 里 session-index MCP 服务在跑（MCP 与技能 → 服务状态），或重启 DSH 后再试。',
        sync: '同步',
        syncTitle: '跨终端同步（会话卡 + 长期记忆）',
        syncRepo: '远端仓库地址（必须是 Private）',
        syncRepoPh: 'git@github.com:你/ dsh-session-index-data.git',
        syncSave: '保存地址',
        syncClear: '清除',
        syncPush: '上传到远端',
        syncPull: '从远端合并',
        syncExport: '导出 zip',
        syncClose: '关闭',
        syncLocal: '本机',
        syncRemote: '远端',
        syncNotConfigured: '还没配置远端仓库：填一个 GitHub Private 仓地址（建议 dsh-session-index-data），保存后即可上传 / 拉取。',
        syncNoGit: '这台机器没有 git 命令，装了 git 才能同步。',
        syncBanner: '远端有新数据（{n} 张会话卡），点「从远端合并」拉过来',
        syncBusy: '处理中…',
        syncLastPush: '上次上传',
        syncLastPull: '上次拉取',
        syncDownload: '下载',
        failed: '取数失败',
        back: '返回列表',
        detailTitle: '会话详情',
        decisions: '结论',
        questions: '提问',
        paths: '涉及路径',
        keywords: '关键词',
        files: '文件',
        tools: '工具',
        noList: '（这一项没有记录）',
        total: '{n} 个会话',
        builtAt: '索引更新于 {t}',
        app: '来源',
        records: '{n} 条记录',
        parent: '上级会话',
        copyId: '复制会话 id',
        copied: '已复制',
      },
      en: {
        panel: 'Sessions',
        search: 'Search sessions…',
        searchHint: 'Search titles, decisions, keywords and paths',
        refresh: 'Refresh',
        status: 'Index status',
        loading: 'Loading…',
        empty: 'No session cards yet. The index builds on first run (about a minute).',
        noHit: 'No matching session.',
        hostUnavailable: 'The Host half did not load, so this panel has no data. Restart DSH or reinstall dsh-session-index.',
        noSession: 'The command channel is agent-scoped, so this panel reads the index through a session. There is none right now: open or start a session and come back.',
        channelHttp: 'HTTP',
        channelCommand: 'command channel',
        bothFailed: 'Both data channels are down: the local HTTP channel (served by the MCP process, 127.0.0.1:8799 up) did not answer, and the command channel has no addressable session. Check that the session-index MCP server is running (MCP & Skills → server status), or restart DSH.',
        sync: 'Sync',
        syncTitle: 'Cross-device sync (session cards + long-term memory)',
        syncRepo: 'Remote repository (must be Private)',
        syncRepoPh: 'git@github.com:you/dsh-session-index-data.git',
        syncSave: 'Save',
        syncClear: 'Clear',
        syncPush: 'Upload',
        syncPull: 'Merge from remote',
        syncExport: 'Export zip',
        syncClose: 'Close',
        syncLocal: 'Local',
        syncRemote: 'Remote',
        syncNotConfigured: 'No remote configured yet: paste a GitHub Private repo address (dsh-session-index-data is a good name), save it, then upload / pull.',
        syncNoGit: 'git is not installed on this machine; sync needs it.',
        syncBanner: 'Remote has newer data ({n} session cards) — use “Merge from remote”',
        syncBusy: 'Working…',
        syncLastPush: 'Last upload',
        syncLastPull: 'Last pull',
        syncDownload: 'Download',
        failed: 'Failed to read the index',
        back: 'Back to list',
        detailTitle: 'Session detail',
        decisions: 'Decisions',
        questions: 'Questions',
        paths: 'Paths',
        keywords: 'Keywords',
        files: 'Files',
        tools: 'Tools',
        noList: '(nothing recorded)',
        total: '{n} sessions',
        builtAt: 'Index built {t}',
        app: 'Source',
        records: '{n} records',
        parent: 'Parent session',
        copyId: 'Copy session id',
        copied: 'Copied',
      },
    };

    const pad = (n) => String(n).padStart(2, '0');
    const fmtTime = (ms) => {
      if (!ms) return '';
      const d = new Date(ms);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const fmtDate = (iso) => {
      if (!iso) return '';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const fill = (text, vars) => String(text).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

    /* ------------------------------------------------------------------ 样式
     * 用 DSH 设计 token，深浅主题都跟着走；面板隐藏时由 React 卸载。
     */
    const CSS = `
.si-panel { position: relative; display: flex; flex-direction: column; flex: 1 1 auto; height: 100%; min-height: 0;
  background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #1d2027); font-size: 13px; }
.si-bar { display: flex; gap: 8px; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e3e5ea); }
.si-input { flex: 1 1 auto; min-width: 0; padding: 7px 10px; border-radius: 8px; font: inherit; font-size: 13px;
  border: 1px solid var(--dsw-alias-border-l2, #d5d8e0); background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; }
.si-input::placeholder { color: var(--dsw-alias-label-secondary, #7a8090); }
.si-btn { padding: 5px 11px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2, #d5d8e0); background: transparent;
  color: var(--dsw-alias-label-secondary, #5a6072); cursor: pointer; font: inherit; font-size: 12.5px; white-space: nowrap; }
.si-btn:hover { color: var(--dsw-alias-label-primary, #1d2027); }
.si-btn.primary { background: var(--dsw-alias-brand-primary, #3b6fd4); border-color: transparent; color: #fff; }
.si-meta { padding: 7px 12px; color: var(--dsw-alias-label-secondary, #7a8090); font-size: 11.5px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #f0f1f4); }
.si-body { flex: 1 1 auto; min-height: 0; display: flex; }
.si-list { flex: 1 1 auto; min-width: 0; min-height: 0; overflow: auto; padding: 8px 10px 24px; }
.si-card { display: block; width: 100%; text-align: left; padding: 9px 11px; margin: 0 0 7px; border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l1, #e6e8ee); border-left: 3px solid var(--dsw-alias-brand-primary, #3b6fd4);
  background: var(--dsw-alias-bg-layer-2, #f7f8fa); color: inherit; cursor: pointer; font: inherit; }
.si-card:hover { border-color: var(--dsw-alias-border-l2, #d5d8e0); }
.si-card.is-on { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #3b6fd4) 9%, transparent); }
.si-card.workbuddy { border-left-color: var(--dsw-alias-state-warn-primary, #e0a020); }
.si-card-title { font-weight: 600; font-size: 13px; line-height: 1.45; margin-bottom: 3px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.si-card-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; color: var(--dsw-alias-label-secondary, #7a8090); font-size: 11px; }
.si-tag { padding: 0 5px; border-radius: 6px; background: var(--dsw-alias-bg-layer-1, #fff);
  border: 1px solid var(--dsw-alias-border-l1, #e6e8ee); font-size: 10.5px; }
.si-digest { margin-top: 5px; color: var(--dsw-alias-label-secondary, #5a6072); font-size: 12px; line-height: 1.55;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.si-detail { flex: 0 0 42%; max-width: 42%; min-width: 0; min-height: 0; overflow: auto;
  border-left: 1px solid var(--dsw-alias-border-l1, #e3e5ea); padding: 12px 14px 28px;
  background: var(--dsw-alias-bg-layer-2, #f7f8fa); }
.si-detail h3 { margin: 0 0 4px; font-size: 14px; line-height: 1.5; }
.si-sec { margin-top: 14px; }
.si-sec h4 { margin: 0 0 6px; font-size: 11px; letter-spacing: .05em; text-transform: uppercase;
  color: var(--dsw-alias-label-secondary, #7a8090); font-weight: 600; }
.si-li { margin: 0 0 6px; padding-left: 11px; position: relative; font-size: 12.5px; line-height: 1.6;
  color: var(--dsw-alias-label-primary, #1d2027); word-break: break-word; }
.si-li::before { content: ''; position: absolute; left: 0; top: .62em; width: 4px; height: 4px; border-radius: 50%;
  background: var(--dsw-alias-brand-primary, #3b6fd4); }
.si-path { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px;
  color: var(--dsw-alias-label-secondary, #5a6072); }
.si-empty { padding: 40px 18px; text-align: center; color: var(--dsw-alias-label-secondary, #7a8090); font-size: 13px; line-height: 1.7; }
.si-err { margin: 10px 12px; padding: 9px 11px; border-radius: 8px; font-size: 12.5px; line-height: 1.6;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d64545) 10%, transparent);
  color: var(--dsw-alias-state-error-primary, #b3312f); }
.si-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.si-chip { padding: 2px 7px; border-radius: 999px; font-size: 11px; cursor: pointer;
  background: var(--dsw-alias-bg-layer-1, #fff); border: 1px solid var(--dsw-alias-border-l1, #e6e8ee);
  color: var(--dsw-alias-label-secondary, #5a6072); }
.si-chip:hover { color: var(--dsw-alias-brand-primary, #3b6fd4); border-color: var(--dsw-alias-brand-primary, #3b6fd4); }
.si-detail-actions { display: flex; gap: 6px; margin-top: 12px; }
.si-count { color: var(--dsw-alias-label-secondary, #7a8090); font-size: 11px; margin-left: auto; }
.si-link { margin-left: auto; padding: 1px 7px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1, #e6e8ee);
  background: transparent; cursor: pointer; font: inherit; font-size: 11px; color: var(--dsw-alias-label-secondary, #5a6072); }
.si-link:hover { color: var(--dsw-alias-brand-primary, #3b6fd4); border-color: var(--dsw-alias-brand-primary, #3b6fd4); }
.si-sync { position: absolute; top: 74px; right: 10px; width: min(430px, calc(100% - 20px)); z-index: 30;
  background: var(--dsw-alias-bg-layer-1, #fff); border: 1px solid var(--dsw-alias-border-l2, #d5d8e0);
  border-radius: 12px; box-shadow: 0 10px 30px rgba(0, 0, 0, .16); padding: 12px 14px 14px;
  font-size: 12.5px; color: var(--dsw-alias-label-primary, #1d2027); }
.si-sync-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.si-sync-head h4 { margin: 0; font-size: 13px; font-weight: 600; flex: 1 1 auto; }
.si-sync label { display: block; font-size: 11px; letter-spacing: .04em; text-transform: uppercase;
  color: var(--dsw-alias-label-secondary, #7a8090); margin: 8px 0 4px; }
.si-sync input { width: 100%; padding: 6px 9px; border-radius: 7px; font: inherit; font-size: 12px;
  border: 1px solid var(--dsw-alias-border-l2, #d5d8e0); background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; }
.si-sync .row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.si-sync .stat { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 8px; padding: 7px 9px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, #f7f8fa); font-size: 11.5px; color: var(--dsw-alias-label-secondary, #5a6072); }
.si-sync .stat b { color: var(--dsw-alias-label-primary, #1d2027); font-weight: 600; }
.si-sync .hint { margin-top: 8px; font-size: 11.5px; line-height: 1.65; color: var(--dsw-alias-label-secondary, #7a8090); }
.si-sync .msg { margin-top: 9px; padding: 7px 9px; border-radius: 8px; font-size: 12px; line-height: 1.6; word-break: break-word; }
.si-sync .msg.ok { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2f9e5f) 12%, transparent);
  color: var(--dsw-alias-state-success-primary, #1f7a46); }
.si-sync .msg.err { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d64545) 10%, transparent);
  color: var(--dsw-alias-state-error-primary, #b3312f); }
.si-banner { margin: 8px 12px 0; padding: 7px 10px; border-radius: 8px; font-size: 12px; line-height: 1.6;
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #e0a020) 16%, transparent);
  color: var(--dsw-alias-state-warn-primary, #8a6210); display: flex; gap: 8px; align-items: center; }
.si-banner button { margin-left: auto; }
`;

    function Styles() {
      useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        if (document.getElementById('si-index-styles')) return undefined;
        const node = document.createElement('style');
        node.id = 'si-index-styles';
        node.textContent = CSS;
        document.head.appendChild(node);
        return () => { node.remove(); };
      }, []);
      return null;
    }

    /* ------------------------------------------------------------------ 数据通道
     * 面板是浏览器半身，读不了文件系统，只能「问」。两条路，**优先 HTTP**：
     *
     *   A. 本地只读 HTTP（首选）——由 MCP 服务进程自己开（127.0.0.1:8799 起，
     *      占用就顺延到 8808），与 agent 用的是**同一份索引、同一套查询实现**。
     *      不需要会话 id、不需要宿主半身那一行 —— 面板从此不再因为
     *      「宿主半身没加载」「会话被归档」而整片取不到数。
     *   B. gateway 命令通道（兜底）——`commands/execute` 是**按 agent 作用域**的，
     *      必须借一个活的会话 id；宿主半身没加载时这条走不通。
     *
     * 端口在 localStorage 里记 10 分钟，省掉每次开面板都要逐个端口探一遍。
     */
    const HTTP_PORTS = [8799, 8800, 8801, 8802, 8803, 8804, 8805, 8806, 8807, 8808];
    const HTTP_URL_KEY = 'si-index-http-url';
    const HTTP_URL_TTL = 10 * 60 * 1000;

    function cachedHttpBase() {
      try {
        const raw = window.localStorage && window.localStorage.getItem(HTTP_URL_KEY);
        if (!raw) return null;
        const hit = JSON.parse(raw);
        if (hit && hit.url && Date.now() - hit.at < HTTP_URL_TTL) return hit.url;
      } catch { /* 存坏了就当作没存 */ }
      return null;
    }

    function rememberHttpBase(url) {
      try {
        window.localStorage && window.localStorage.setItem(HTTP_URL_KEY, JSON.stringify({ url, at: Date.now() }));
      } catch { /* 隐私模式等 */ }
    }

    function fetchImpl() {
      if (typeof fetch === 'function') return fetch;
      if (typeof window !== 'undefined' && typeof window.fetch === 'function') return window.fetch;
      return null;
    }

    /** 探一个可用的 HTTP 端点：先试记住的，再从 8799 往后试。 */
    async function probeHttpBase() {
      const doFetch = fetchImpl();
      if (!doFetch) return null;
      const tryUrl = async (base) => {
        const res = await doFetch(base + '/api/health', { cache: 'no-store', signal: AbortSignal.timeout(900) });
        return res.ok ? base : null;
      };
      const cached = cachedHttpBase();
      if (cached) {
        try {
          const ok = await tryUrl(cached);
          if (ok) return ok;
        } catch { /* 掉了就重探 */ }
      }
      for (const port of HTTP_PORTS) {
        const base = `http://127.0.0.1:${port}`;
        try {
          const hit = await tryUrl(base);
          if (hit) { rememberHttpBase(hit); return hit; }
        } catch { /* 下一个 */ }
      }
      return null;
    }

    /** 取一个 JSON 接口；非 200 抛出带 channel 标记的错误。 */
    async function httpGet(base, pathAndQuery) {
      const res = await fetchImpl()(base + pathAndQuery, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error((body && body.error) || `HTTP ${res.status}`);
        err.channel = 'http';
        throw err;
      }
      return body;
    }

    /* ------------------------------------------------------------------ 面板 */

    /**
     * 从 shell 的会话快照里挑一个**可寻址的会话 id**。
     *
     * `ctx.remote.commands.execute(sessionId, line, [])` 这条命令通道是
     * **按 agent 作用域**的（wire 字段 `agentId`，类型是 SessionId），所以第一个
     * 参数必须是真实存在、且没被归档/移除的会话 id 字符串。传快照对象或 undefined
     * 都会在网关的边界校验里炸成
     * `gateway/input-invalid: typert gateway: commands/execute: wire field "agentId"
     * failed boundary validation`——面板看起来就是「一片空白 + 一行报错」。
     *
     * 挑选顺序：正在屏上的（有 retainedBy 计数）→ 更新时间最新的活会话。
     */
    function pickSessionId(snapshot) {
      const state = snapshot || {};
      const byId = (state.byId && typeof state.byId === 'object' ? state.byId : null)
        || (state.list && typeof state.list === 'object' && state.list.byId && typeof state.list.byId === 'object' ? state.list.byId : null)
        || {};
      const ids = Array.isArray(state.ids) && state.ids.length > 0 ? state.ids : Object.keys(byId);
      const rows = ids
        .map((id) => ({ id, row: byId[id] }))
        .filter((entry) => entry.row && entry.row.archived !== true && entry.row.removed !== true);
      if (rows.length === 0) return undefined;

      const retained = rows.find((entry) => {
        const row = entry.row;
        const counts = row.retainedBy || (row.retainInfo && row.retainInfo.retainedBy) || (row.retain && row.retain.retainedBy);
        return counts && typeof counts === 'object'
          && Object.keys(counts).some((key) => typeof counts[key] === 'number' && counts[key] > 0);
      });
      if (retained) return retained.id;

      const stamp = (row) => {
        const raw = row.updatedAt ?? row.updatedAtMs ?? row.lastActivityAt ?? row.createdAt ?? 0;
        if (typeof raw === 'number') return raw;
        const parsed = Date.parse(raw);
        return Number.isNaN(parsed) ? 0 : parsed;
      };
      return rows.slice().sort((a, b) => stamp(b.row) - stamp(a.row))[0].id;
    }

    function SessionPanel(props) {
      const t = props.t || ((k) => (DICT.zh[k] || k));
      const run = props.run;
      const useSessions = props.useSessions;
      // 取的是 id 字符串，不是整份快照：拿快照当 agentId 会被网关的边界校验拒掉。
      const sessionId = typeof useSessions === 'function' ? useSessions(pickSessionId) : undefined;

      const [query, setQuery] = useState('');
      const [items, setItems] = useState(null);
      const [meta, setMeta] = useState(null);
      const [detail, setDetail] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [channel, setChannel] = useState('');
      const [tick, setTick] = useState(0);

      // 跨终端同步模块（唯一会写盘 / 调 git 的一组接口，需要自定义头）
      const [syncOpen, setSyncOpen] = useState(false);
      const [sync, setSync] = useState(null);
      const [syncBusy, setSyncBusy] = useState(false);
      const [syncMsg, setSyncMsg] = useState(null);
      const [repoInput, setRepoInput] = useState('');

      const load = useCallback(async () => {
        setBusy(true);
        setError('');
        const isSearch = Boolean(query.trim());
        const commandLine = isSearch ? `session-index search ${query.trim()}` : 'session-index list 60';
        const httpPath = isSearch
          ? `/api/search?q=${encodeURIComponent(query.trim())}&limit=40`
          : '/api/list?limit=60';
        const fallback = (message) => new Error(`${t('bothFailed')}（命令通道：${message}）`);
        try {
          // 首选：本地 HTTP 通道 —— MCP 服务进程自己开的，不需要会话、不依赖宿主半身。
          // 探测本身出错（老环境没有 fetch / AbortSignal）不当成失败，直接落回命令通道。
          let base = null;
          try { base = await probeHttpBase(); } catch { base = null; }
          if (base) {
            const payload = await httpGet(base, httpPath);
            if (!payload || payload.ok === false) throw new Error((payload && payload.error) || 'bad payload');
            setChannel(`${t('channelHttp')} · ${base.replace('http://', '')}`);
            setItems(payload.items || []);
            setDetail(null);
            if (!isSearch) {
              const s = await httpGet(base, '/api/status').catch(() => null);
              if (s && s.ok) setMeta(s);
            }
            return;
          }
          // 兜底：命令通道（按 agent 作用域，必须借一个活会话）。
          if (typeof sessionId !== 'string' || sessionId === '') throw fallback('没有可用会话');
          let payload;
          try {
            payload = await run(sessionId, commandLine);
          } catch (err) {
            throw fallback(err && err.message ? err.message : String(err));
          }
          if (!payload || payload.ok === false) throw fallback((payload && payload.error) || 'bad payload');
          setChannel(t('channelCommand'));
          setItems(payload.items || []);
          setDetail(null);
          if (!isSearch) {
            const s = await run(sessionId, 'session-index status').catch(() => null);
            if (s && s.ok) setMeta(s);
          }
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
          setItems([]);
        } finally {
          setBusy(false);
        }
      }, [query, run, sessionId, t]);

      // 首次与每次搜索词变化（300ms 防抖）
      useEffect(() => {
        const timer = setTimeout(() => { void load(); }, 300);
        return () => clearTimeout(timer);
      }, [load, tick]);

      const openCard = useCallback(async (id) => {
        setBusy(true);
        setError('');
        try {
          let base = null;
          try { base = await probeHttpBase(); } catch { base = null; }
          if (base) {
            const payload = await httpGet(base, `/api/card?id=${encodeURIComponent(id)}`);
            if (!payload || payload.ok === false) throw new Error((payload && payload.error) || 'bad payload');
            setDetail(payload.card || null);
            return;
          }
          if (typeof sessionId !== 'string' || sessionId === '') throw new Error(t('bothFailed'));
          const payload = await run(sessionId, 'session-index card ' + id);
          if (!payload || payload.ok === false) throw new Error((payload && payload.error) || 'bad payload');
          setDetail(payload.card || null);
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      }, [run, sessionId, t]);

      const searchAs = useCallback((word) => setQuery(word), []);

      /* ---- 跨终端同步（唯一会写盘 / 调 git 的一组接口，必须带自定义头）---- */
      const syncFetch = useCallback(async (path, { method = 'GET', body } = {}) => {
        const base = await probeHttpBase();
        if (!base) throw new Error(t('bothFailed'));
        const res = await fetch(base + path, {
          method,
          headers: body
            ? { 'Content-Type': 'application/json', 'X-Session-Index-Sync': '1' }
            : { 'X-Session-Index-Sync': '1' },
          body: body ? JSON.stringify(body) : undefined,
          cache: 'no-store',
          // git clone / push 可能要几十秒，别用默认的短超时把它掐了
          signal: AbortSignal.timeout(120000),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || data.ok === false) {
          const err = new Error((data && data.error) || `HTTP ${res.status}`);
          if (data && data.hint) err.hint = data.hint;
          throw err;
        }
        return data;
      }, [t]);

      const loadSync = useCallback(async () => {
        try {
          const st = await syncFetch('/api/sync/status');
          setSync(st);
          setRepoInput(st.repo || '');
          setSyncMsg(null);
        } catch (e) {
          setSyncMsg({ ok: false, text: (e && e.message) || String(e) });
        }
      }, [syncFetch]);

      const describeSync = useCallback((action, r) => {
        if (action === 'config') return r.configured ? '已保存远端地址' : '已清除远端地址';
        if (action === 'push') {
          return r.changed
            ? `已上传：${r.cards} 张会话卡 / ${r.notes} 条记忆${r.commit ? `（${r.commit}）` : ''}`
            : '远端已是最新，没有需要上传的改动';
        }
        if (action === 'pull') {
          const parts = [];
          if (r.added) parts.push(`新增 ${r.added} 张会话卡`);
          if (r.updated) parts.push(`更新 ${r.updated} 张`);
          if (r.notesAdded) parts.push(`新增 ${r.notesAdded} 条记忆`);
          if (r.notesUpdated) parts.push(`更新 ${r.notesUpdated} 条记忆`);
          return parts.length
            ? `已合并：${parts.join('、')}（现在 ${r.cards} 卡 / ${r.notes} 记忆）`
            : '远端没有比本机更新的数据';
        }
        if (action === 'export') return `已导出到 ${r.file}`;
        return 'ok';
      }, []);

      const runSync = useCallback(async (action, body) => {
        setSyncBusy(true);
        setSyncMsg(null);
        try {
          const r = await syncFetch(`/api/sync/${action}`, { method: 'POST', body: body || {} });
          setSyncMsg({ ok: true, text: describeSync(action, r) });
          if (r.status) setSync(r.status);
          if (action === 'config') setRepoInput((r.status && r.status.repo) || '');
          if (action === 'pull') setTick((n) => n + 1); // 合并完把列表刷一遍
        } catch (e) {
          setSyncMsg({
            ok: false,
            text: ((e && e.message) || String(e)) + (e && e.hint ? ` — ${e.hint}` : ''),
          });
        } finally {
          setSyncBusy(false);
        }
      }, [syncFetch, describeSync]);

      // 打开面板就后台取一次同步状态：配置过就顺带看一眼远端有没有新数据
      // （未配置时这个接口是瞬时返回的，不走 git；已配置也只是异步，不挡列表渲染）。
      useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            const st = await syncFetch('/api/sync/status');
            if (cancelled) return;
            setSync(st);
            setRepoInput(st.repo || '');
          } catch {
            /* 同步没配好 / 没装 git 都不影响面板主功能 */
          }
        })();
        return () => { cancelled = true; };
      }, [syncFetch]);

      const list = useMemo(() => items || [], [items]);

      return h('div', { className: 'si-panel' },
        h(Styles),
        h('div', { className: 'si-bar' },
          h('input', {
            className: 'si-input', value: query, placeholder: t('search') + ' — ' + t('searchHint'),
            spellCheck: false, 'aria-label': t('search'),
            onChange: (e) => setQuery(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') setTick((n) => n + 1); if (e.key === 'Escape') { setQuery(''); setDetail(null); } },
          }),
          h('button', { className: 'si-btn', onClick: () => setTick((n) => n + 1) }, t('refresh')),
        ),
        h('div', { className: 'si-meta' },
          meta ? `${fill(t('total'), { n: meta.total })} · ${fill(t('builtAt'), { t: fmtTime(Date.parse(meta.builtAt)) })}` : (busy ? t('loading') : ''),
          busy ? h('span', { className: 'si-count' }, t('loading'))
            : channel ? h('span', { className: 'si-count' }, channel) : null,
          h('button', {
            className: 'si-link',
            onClick: () => {
              const next = !syncOpen;
              setSyncOpen(next);
              if (next) void loadSync();
            },
          }, t('sync')),
        ),
        // 首次启动提示：远端有比本机更新的数据时给一条可点的横幅（配置过才可能出现）
        sync && sync.configured && sync.remote && sync.remote.ok && sync.remote.ahead && sync.remote.manifest
          ? h('div', { className: 'si-banner' },
            fill(t('syncBanner'), { n: sync.remote.manifest.cards || 0 }),
            h('button', { className: 'si-btn', disabled: syncBusy, onClick: () => void runSync('pull') }, t('syncPull')))
          : null,
        syncOpen ? h('div', { className: 'si-sync' },
          h('div', { className: 'si-sync-head' },
            h('h4', null, t('syncTitle')),
            h('button', { className: 'si-btn', onClick: () => setSyncOpen(false) }, t('syncClose')),
          ),
          h('label', null, t('syncRepo')),
          h('input', {
            value: repoInput,
            placeholder: t('syncRepoPh'),
            spellCheck: false,
            'aria-label': t('syncRepo'),
            onChange: (e) => setRepoInput(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') void runSync('config', { repo: repoInput.trim() }); },
          }),
          h('div', { className: 'row' },
            h('button', {
              className: 'si-btn primary', disabled: syncBusy,
              onClick: () => void runSync('config', { repo: repoInput.trim() }),
            }, t('syncSave')),
            h('button', {
              className: 'si-btn', disabled: syncBusy || !sync || !sync.configured,
              onClick: () => void runSync('config', { repo: '' }),
            }, t('syncClear')),
            h('button', {
              className: 'si-btn', disabled: syncBusy,
              onClick: () => void loadSync(),
            }, t('refresh')),
          ),
          sync ? h('div', { className: 'stat' },
            h('span', null, t('syncLocal'), ' ', h('b', null, `${sync.local.cards} 卡 / ${sync.local.notes} 记忆`)),
            sync.remote && sync.remote.manifest
              ? h('span', null, t('syncRemote'), ' ',
                h('b', null, `${sync.remote.manifest.cards} 卡 / ${sync.remote.manifest.notes} 记忆`),
                ' · ', String(sync.remote.manifest.machine || ''))
              : null,
            sync.lastPushAt
              ? h('span', null, t('syncLastPush'), ' ', h('b', null, fmtTime(Date.parse(sync.lastPushAt))))
              : null,
            sync.lastPullAt
              ? h('span', null, t('syncLastPull'), ' ', h('b', null, fmtTime(Date.parse(sync.lastPullAt))))
              : null,
          ) : null,
          h('div', { className: 'row' },
            h('button', {
              className: 'si-btn primary', disabled: syncBusy || !sync || !sync.configured,
              onClick: () => void runSync('push'),
            }, t('syncPush')),
            h('button', {
              className: 'si-btn', disabled: syncBusy || !sync || !sync.configured,
              onClick: () => void runSync('pull'),
            }, t('syncPull')),
            h('button', {
              className: 'si-btn', disabled: syncBusy,
              onClick: () => void runSync('export'),
            }, t('syncExport')),
          ),
          sync && !sync.configured
            ? h('div', { className: 'hint' }, sync.gitAvailable === false ? t('syncNoGit') : t('syncNotConfigured'))
            : null,
          sync && sync.remote && sync.remote.ok === false
            ? h('div', { className: 'msg err' }, String(sync.remote.error || '') + (sync.remote.hint ? ` — ${sync.remote.hint}` : ''))
            : null,
          syncMsg ? h('div', { className: 'msg ' + (syncMsg.ok ? 'ok' : 'err') }, syncMsg.text) : null,
          syncBusy ? h('div', { className: 'hint' }, t('syncBusy')) : null,
        ) : null,
        error ? h('div', { className: 'si-err' }, error) : null,
        h('div', { className: 'si-body' },
          h('div', { className: 'si-list' },
            items === null && !error ? h('div', { className: 'si-empty' }, t('loading')) : null,
            items !== null && items.length === 0 && !error
              ? h('div', { className: 'si-empty' }, query.trim() ? t('noHit') : t('empty'))
              : null,
            list.map((c) => h('button', {
              key: c.id,
              className: 'si-card' + (c.app === 'workbuddy' ? ' workbuddy' : '') + (detail && detail.id === c.id ? ' is-on' : ''),
              onClick: () => void openCard(c.id),
            },
              h('div', { className: 'si-card-title' }, c.title || c.id),
              h('div', { className: 'si-card-meta' },
                h('span', { className: 'si-tag' }, c.app === 'workbuddy' ? 'WorkBuddy' : 'DSH'),
                h('span', null, fmtTime(c.updatedAt)),
                h('span', null, fill(t('records'), { n: c.recordCount })),
                c.questionCount ? h('span', { className: 'si-tag' }, `${c.questionCount} 问`) : null,
                c.decisionCount ? h('span', { className: 'si-tag' }, `${c.decisionCount} 结论`) : null,
              ),
              c.digest ? h('div', { className: 'si-digest' }, c.digest) : null,
              c.keywords && c.keywords.length ? h('div', { className: 'si-card-meta', style: { marginTop: '5px' } },
                c.keywords.slice(0, 6).map((k) => h('span', { key: k, className: 'si-tag' }, k))) : null,
            )),
          ),
          detail ? h('div', { className: 'si-detail' },
            h('div', { className: 'si-detail-actions' },
              h('button', { className: 'si-btn', onClick: () => setDetail(null) }, '← ' + t('back')),
              h('button', {
                className: 'si-btn',
                onClick: async () => {
                  try { await navigator.clipboard.writeText(detail.id); } catch { /* ignore */ }
                },
              }, t('copyId')),
            ),
            h('h3', null, detail.title || detail.id),
            h('div', { className: 'si-card-meta' },
              h('span', { className: 'si-tag' }, detail.app === 'workbuddy' ? 'WorkBuddy' : 'DSH'),
              h('span', null, fmtTime(detail.updatedAt)),
              h('span', null, fill(t('records'), { n: detail.recordCount })),
            ),
            detail.parentSession ? h('div', { className: 'si-sec' },
              h('h4', null, t('parent')),
              h('div', { className: 'si-li si-path' }, detail.parentSession)) : null,
            h(Section, { title: t('decisions'), list: detail.decisions, t }),
            h(Section, { title: t('questions'), list: detail.questions, t }),
            h(Section, { title: t('paths'), list: detail.paths, t, mono: true }),
            h(Section, { title: t('files'), list: detail.files, t, mono: true }),
            h(Section, { title: t('keywords'), list: detail.keywords, t, chips: true, onPick: searchAs }),
            h(Section, { title: t('tools'), list: detail.tools, t, mono: true }),
            detail.digest ? h('div', { className: 'si-sec' },
              h('h4', null, 'Digest'),
              h('div', { className: 'si-li' }, detail.digest)) : null,
          ) : null,
        ),
      );
    }

    function Section({ title, list, t, mono, chips, onPick }) {
      if (!list || !list.length) return null;
      return h('div', { className: 'si-sec' },
        h('h4', null, title, ' · ', list.length),
        chips
          ? h('div', { className: 'si-chips' }, list.map((x) => h('button', {
            key: x, className: 'si-chip', onClick: () => onPick && onPick(x),
          }, x)))
          : list.slice(0, 60).map((x, i) => h('div', {
            key: i, className: 'si-li' + (mono ? ' si-path' : ''),
          }, String(x))),
      );
    }

    /* ------------------------------------------------------------------ 侧栏图标
     * 一张卡片 + 放大镜，右下角小点提示索引是否可用（由 meta 决定）。
     */
    function SessionIcon({ size = 18 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M4 6.5A1.5 1.5 0 0 1 5.5 5h8A1.5 1.5 0 0 1 15 6.5v3A1.5 1.5 0 0 1 13.5 11h-8A1.5 1.5 0 0 1 4 9.5z' }),
        h('path', { d: 'M4 13.5A1.5 1.5 0 0 1 5.5 12h5' }),
        h('path', { d: 'M4 17.5A1.5 1.5 0 0 1 5.5 16h3' }),
        h('circle', { cx: 16.5, cy: 15.5, r: 3.6 }),
        h('path', { d: 'M19.3 18.3 22 21' }),
      );
    }

    /* ------------------------------------------------------------------ 注册 */
    function apply(ctx) {
      // 面板取数：包一层，把「宿主半身没加载」翻成人话
      const run = async (sessionId, line) => {
        if (!ctx.remote || !ctx.remote.commands || typeof ctx.remote.commands.execute !== 'function') {
          throw new Error(DICT.zh.hostUnavailable);
        }
        // 命令通道按 agent 寻址：空会话 id 会在网关里变成 agentId 边界校验失败。
        // 这里用 DICT 而不是 t：run 定义在 t 之前，闭包里直接取词典更稳。
        if (typeof sessionId !== 'string' || sessionId === '') {
          throw new Error(DICT.zh.noSession);
        }
        const response = await ctx.remote.commands.execute(sessionId, line, []);
        if (!response || !response.ok) {
          const err = (response && response.error) || {};
          throw new Error(`${err.code || 'error'}: ${err.message || 'command failed'}`);
        }
        if (response.value === undefined) throw new Error(DICT.zh.hostUnavailable);
        const result = response.value.result;
        if (!result) throw new Error(DICT.zh.hostUnavailable);
        if (result.kind !== 'success') throw new Error(result.text || DICT.zh.failed);
        try {
          return JSON.parse(result.text);
        } catch {
          throw new Error(DICT.zh.failed);
        }
      };

      if (typeof ctx.locale !== 'undefined' && ctx.locale) {
        ctx.locale.register(NS, DICT);
      }
      const t = typeof ctx.locale === 'function'
        ? ctx.locale(NS)
        : (ctx.locale && ctx.locale.bind ? ctx.locale.bind(NS) : (k) => (DICT.zh[k] || k));

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({ run }),
      }, SessionPanel));

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 45,
        label: () => t('panel'),
        locale: NS,
      }, SessionIcon));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = 'dsh-session-index';
    /** 供单测直接调用：从会话快照里挑可寻址的 id，以及 HTTP 端点探测。 */
    exports.__test = { pickSessionId, probeHttpBase, cachedHttpBase, HTTP_PORTS };
    return module.exports;
  },
});
