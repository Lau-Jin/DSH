/**
 * 发布工具的路径解析 —— **换机器 / 换目录也能用**。
 *
 * 这层是 2026-08 之前踩坑的产物：原来三个发布脚本把
 * 「源仓库路径 / 发布副本目录 / DSH profile 目录」全写死成这台机器的绝对路径，
 * 工具本身又不在任何 git 仓库里 —— 换台机器发布就直接断掉，而且没人知道它去哪了。
 *
 * 现在的取值优先级（从高到低）：
 *   1. 环境变量：PUBLISH_COPY_ROOT / DSH_PROFILE_DIR / PUBLISH_SRC_<KEY>
 *   2. `tools/publish/config.local.json`（**不入库**，各机器自己的路径）
 *   3. 默认值：副本落在 `<仓根>/dist/publish`（已 gitignore）、profile 用 `~/.dsh/profiles/desktop`
 *
 * 换机器时只要写一份 config.local.json（或设环境变量），工具不用改一行代码。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 工具所在目录（<仓根>/tools/publish）。 */
export const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
/** 仓根（<仓根>/tools/publish → <仓根>）。 */
export const REPO_ROOT = path.resolve(TOOL_DIR, '..', '..');
/** 本机私有配置（不入库）。 */
export const LOCAL_CONFIG_FILE = path.join(TOOL_DIR, 'config.local.json');

function readLocalConfig() {
  try {
    // 容忍 BOM：Windows PowerShell 的 `Set-Content -Encoding UTF8` 会写 BOM，
    // Notepad 另存为 UTF-8 也会 —— 直接 JSON.parse 会整份配置静默失效（退回默认值）。
    const raw = fs.readFileSync(LOCAL_CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
    const cfg = JSON.parse(raw);
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    return {};
  }
}

const envKey = (key) => `PUBLISH_SRC_${String(key).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

/**
 * 发布副本根目录：三个插件的副本都放这里，互不影响。
 * @returns {string}
 */
export function copyRoot() {
  const cfg = readLocalConfig();
  return path.resolve(
    process.env.PUBLISH_COPY_ROOT || cfg.copyRoot || path.join(REPO_ROOT, 'dist', 'publish'),
  );
}

/**
 * 某个插件的**源目录**。
 * @param {string} key 插件 key（session-index / weekly-report / siyuan-bridge）
 * @param {string} fallback 默认路径（当前机器的布局）
 */
export function pluginSrc(key, fallback) {
  const cfg = readLocalConfig();
  const fromLocal = cfg.plugins && cfg.plugins[key] && cfg.plugins[key].src;
  return path.resolve(process.env[envKey(key)] || fromLocal || fallback);
}

/**
 * DSH profile 目录（装着 node_modules / cordis.patch.yml 的那个）。
 */
export function profileDir() {
  const cfg = readLocalConfig();
  return path.resolve(
    process.env.DSH_PROFILE_DIR || cfg.profileDir
      || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'desktop'),
  );
}

/** 诊断信息：门禁/同步脚本开头打一行，让人一眼看出当前用的是哪套路径。 */
export function pathSummary() {
  return {
    toolDir: TOOL_DIR,
    repoRoot: REPO_ROOT,
    copyRoot: copyRoot(),
    profileDir: profileDir(),
    localConfig: fs.existsSync(LOCAL_CONFIG_FILE) ? LOCAL_CONFIG_FILE : '（无，用默认值）',
  };
}
