/**
 * 新会话事件驱动识别：递归监听 DSH / WorkBuddy 会话目录。
 *
 * 目标：新会话产生后无需重启 DSH、无需等定时轮询，几秒内即可被检索。
 * 做法：fs.watch(recursive) 捕获写入事件 → 防抖 → 回调触发增量构建；
 * 构建器自身带「活跃文件静止期」，所以正在写入的会话会在停笔后自动纳入。
 * 若平台不支持递归监听（权限/旧内核），静默失败，由 AutoIndex 的定时轮询兜底。
 */
import fs from 'node:fs';

export class SessionWatcher {
  constructor({ dirs = [], onChange, debounceMs = 3500, quietMs = 6000, log = () => {} } = {}) {
    this.dirs = dirs.filter(Boolean);
    this.onChange = onChange || (() => {});
    this.debounceMs = Math.max(500, debounceMs);
    this.quietMs = Math.max(0, quietMs);
    this.log = log;
    this.watchers = [];
    this.timer = null;
    this.pending = new Set();
    this.state = {
      supported: true,
      watching: 0,
      failed: 0,
      events: 0,
      lastEventAt: null,
      lastTriggeredAt: null,
      debounceMs: this.debounceMs,
      quietMs: this.quietMs,
      dirs: this.dirs,
    };
  }

  start() {
    for (const dir of this.dirs) {
      if (!fs.existsSync(dir)) {
        this.state.failed += 1;
        this.log(`watch 目录不存在: ${dir}`);
        continue;
      }
      try {
        const w = fs.watch(dir, { recursive: true, persistent: false }, (event, filename) => {
          const f = String(filename || '');
          // 只关心会话数据文件；目录事件与其它日志忽略
          if (f && !/\.jsonl(\.zstd)?$/i.test(f)) return;
          this.state.events += 1;
          this.state.lastEventAt = new Date().toISOString();
          this.pending.add(f || '(unknown)');
          this.schedule();
        });
        w.on('error', (e) => this.log(`watch 出错 ${dir}: ${e.message}`));
        this.watchers.push(w);
        this.state.watching += 1;
      } catch (e) {
        this.state.failed += 1;
        this.log(`watch 不可用 ${dir}: ${e.message}（由定时轮询兜底）`);
      }
    }
    if (this.state.watching === 0) this.state.supported = false;
    return this.state;
  }

  schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const files = [...this.pending];
      this.pending.clear();
      if (files.length === 0) return;
      this.state.lastTriggeredAt = new Date().toISOString();
      try {
        this.onChange({ files, quietMs: this.quietMs, reason: 'fs-event' });
      } catch (e) {
        this.log('watch 回调失败: ' + e.message);
      }
    }, this.debounceMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** 手动触发一次（供 tools/call 前的即时检查复用）。 */
  trigger(reason = 'manual') {
    this.state.lastTriggeredAt = new Date().toISOString();
    this.onChange({ files: [], quietMs: this.quietMs, reason });
  }

  snapshot() {
    return { ...this.state, pendingEvents: this.pending.size };
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    this.watchers = [];
  }
}
