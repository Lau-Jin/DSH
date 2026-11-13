/**
 * 自动索引守护：让插件「装上即用」，新会话无需重启即可被识别。
 *
 * - server 启动时自动确保索引存在：没有索引就后台全量建，已有则增量补齐
 * - 定时轮询增量刷新（兜底）
 * - fs.watch 递归监听会话目录：新文件/写入事件防抖后立即触发增量构建（主路径）
 * - tools/call 前做一次轻量 stat 检查，发现变化即时触发，不等定时器
 * - 构建在独立子进程执行，绝不阻塞 MCP stdio 主进程的请求响应
 * - 索引确有更新时回调，由 server 发送 MCP list_changed 通知
 *
 * 环境变量：
 *   SESSION_INDEX_AUTO=0                关闭全部自动维护
 *   SESSION_INDEX_AUTO_INTERVAL_MS     轮询间隔，默认 60000，最小 15000
 *   SESSION_INDEX_AUTO_QUIET_MS        定时刷新的活跃文件静止判定，默认 45000
 *   SESSION_INDEX_WATCH=0              关闭文件事件监听（仍保留轮询）
 *   SESSION_INDEX_WATCH_DEBOUNCE_MS    事件防抖，默认 3500
 *   SESSION_INDEX_WATCH_QUIET_MS       事件触发时的静止判定，默认 6000
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMeta, signatureOf } from './index-store.mjs';
import { SessionWatcher } from './watch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.join(here, '..');
const BUILDER = path.join(PLUGIN_DIR, 'build-index.mjs');

const numEnv = (v, fallback) => {
  if (v === undefined || v === '' || v === null) return fallback;
  const n = Number(v);
  // 不能用 `n || fallback`：0 是合法配置值（关闭静止期/立即处理），会被误回退
  return Number.isFinite(n) ? n : fallback;
};

export function autoConfig(env = process.env) {
  return {
    enabled: String(env.SESSION_INDEX_AUTO || '1') !== '0',
    intervalMs: Math.max(15000, numEnv(env.SESSION_INDEX_AUTO_INTERVAL_MS, 60000)),
    quietMs: Math.max(0, numEnv(env.SESSION_INDEX_AUTO_QUIET_MS, 45000)),
    watchEnabled: String(env.SESSION_INDEX_WATCH || '1') !== '0',
    watchDebounceMs: Math.max(500, numEnv(env.SESSION_INDEX_WATCH_DEBOUNCE_MS, 3500)),
    watchQuietMs: Math.max(0, numEnv(env.SESSION_INDEX_WATCH_QUIET_MS, 6000)),
  };
}

function scanSessionFiles(root, maxDepth = 3, out = []) {
  if (!root || !fs.existsSync(root)) return out;
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && /\.jsonl(\.zstd)?$/i.test(e.name)) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

export class AutoIndex {
  constructor({ indexDir, sessionsRoot, watchDirs = [], onIndexUpdated = () => {}, log = () => {} } = {}) {
    this.indexDir = indexDir;
    this.sessionsRoot = sessionsRoot;
    this.watchDirs = watchDirs.length ? watchDirs : [sessionsRoot].filter(Boolean);
    this.onIndexUpdated = onIndexUpdated;
    this.log = log;
    this.cfg = autoConfig();
    this.state = {
      enabled: this.cfg.enabled,
      intervalMs: this.cfg.intervalMs,
      quietMs: this.cfg.quietMs,
      watchEnabled: this.cfg.watchEnabled,
      watchDebounceMs: this.cfg.watchDebounceMs,
      watchQuietMs: this.cfg.watchQuietMs,
      building: false,
      runs: 0,
      failures: 0,
      notifications: 0,
      lastRunAt: null,
      lastResult: null,
      lastError: null,
    };
    this.timer = null;
    this.child = null;
    this.watcher = null;
    this.lastEnsureAt = 0;
  }

  snapshot() {
    const s = this.state;
    let nextRunInMs = null;
    if (s.enabled && s.lastRunAt) {
      nextRunInMs = Math.max(0, s.intervalMs - (Date.now() - new Date(s.lastRunAt).getTime()));
    }
    return {
      ...s,
      nextRunInMs,
      watch: this.watcher ? this.watcher.snapshot() : { supported: false, watching: 0, reason: 'disabled' },
    };
  }

  /** 启动自检 + 定时刷新 + 文件事件监听。全部在后台，不阻塞 initialize。 */
  start() {
    if (!this.cfg.enabled) {
      this.log('自动维护已关闭（SESSION_INDEX_AUTO=0），可用 session_index_refresh 手动刷新');
      return;
    }
    let empty = true;
    try {
      const meta = loadMeta(this.indexDir, this.sessionsRoot);
      empty = Object.keys(meta.sessions || {}).length === 0;
    } catch {
      empty = true;
    }
    const reason = empty ? 'initial-build' : 'startup-refresh';
    setImmediate(() => {
      this.run({ quietMs: empty ? 0 : this.cfg.quietMs, reason }).catch(() => {});
    });

    this.timer = setInterval(() => {
      this.run({ quietMs: this.cfg.quietMs, reason: 'interval' }).catch(() => {});
    }, this.cfg.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();

    if (this.cfg.watchEnabled) {
      this.watcher = new SessionWatcher({
        dirs: this.watchDirs,
        debounceMs: this.cfg.watchDebounceMs,
        quietMs: this.cfg.watchQuietMs,
        log: this.log,
        onChange: ({ quietMs, reason: why }) => {
          this.run({ quietMs, reason: why }).catch(() => {});
        },
      });
      const st = this.watcher.start();
      this.log(`会话监听已启动: ${st.watching} 个目录 / 失败 ${st.failed} / 防抖 ${st.debounceMs}ms`);
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.watcher) this.watcher.stop();
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // ignore
      }
    }
  }

  /**
   * 轻量即时检查：只 stat 源文件（不解压），发现变化立刻触发后台构建。
   * 供 tools/call 前调用，让新会话不必等定时器。
   */
  ensureFresh() {
    if (!this.cfg.enabled) return { pending: 0, triggered: false, reason: 'auto-disabled' };
    if (this.state.building) return { pending: 0, triggered: false, reason: 'building' };
    try {
      const meta = loadMeta(this.indexDir, this.sessionsRoot);
      const known = new Map(
        Object.values(meta.sessions || {}).map((s) => [s.sourcePath, s.signature])
      );
      let pending = 0;
      for (const root of this.watchDirs) {
        for (const file of scanSessionFiles(root)) {
          try {
            if (known.get(file) !== signatureOf(fs.statSync(file))) pending += 1;
          } catch {
            // ignore
          }
        }
      }
      if (pending > 0) {
        this.run({ quietMs: this.cfg.watchQuietMs, reason: 'on-demand' }).catch(() => {});
        return { pending, triggered: true, reason: 'on-demand' };
      }
      return { pending: 0, triggered: false, reason: 'up-to-date' };
    } catch (e) {
      return { pending: 0, triggered: false, reason: 'check-failed', error: e.message };
    }
  }

  run({ quietMs = 0, reason = 'manual' } = {}) {
    if (this.state.building) return Promise.resolve({ skipped: true, reason: 'already-building' });
    this.state.building = true;
    this.state.lastRunAt = new Date().toISOString();
    return new Promise((resolve) => {
      const args = [BUILDER, '--json'];
      if (quietMs > 0) args.push('--quiet', String(quietMs));
      let out = '';
      let err = '';
      let child;
      try {
        child = spawn(process.execPath, args, {
          cwd: PLUGIN_DIR,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        this.finish(null, e.message, reason);
        resolve(this.snapshot());
        return;
      }
      this.child = child;
      child.stdout.on('data', (d) => (out += d.toString()));
      child.stderr.on('data', (d) => (err += d.toString()));
      child.on('error', (e) => {
        this.finish(null, e.message, reason);
        resolve(this.snapshot());
      });
      child.on('close', (code) => {
        let parsed = null;
        try {
          parsed = JSON.parse(out);
        } catch {
          // 非 JSON 输出视为失败
        }
        if (code === 0 && parsed) this.finish(parsed, null, reason);
        else this.finish(null, err.trim() || `builder exit ${code}`, reason);
        resolve(this.snapshot());
      });
    });
  }

  finish(result, error, reason) {
    this.state.building = false;
    this.state.runs += 1;
    if (result) {
      this.state.lastResult = {
        reason,
        rebuilt: result.rebuilt,
        skipped: result.skipped,
        deferred: result.deferred || 0,
        elapsedMs: result.elapsedMs,
        sessions: result.sessionsIndexed,
      };
      this.state.lastError = null;
      this.log(
        `auto-index ${reason}: 重建 ${result.rebuilt} / 跳过 ${result.skipped} / 延迟(活跃) ${result.deferred || 0} / ${result.elapsedMs}ms`
      );
      if (result.rebuilt > 0) {
        this.state.notifications += 1;
        try {
          this.onIndexUpdated(this.state.lastResult);
        } catch (e) {
          this.log('索引更新回调失败: ' + e.message);
        }
      }
    } else {
      this.state.failures += 1;
      this.state.lastError = error;
      this.log('auto-index 失败: ' + error);
    }
    this.child = null;
  }
}
