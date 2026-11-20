/**
 * 工作区归一化 —— 会话卡的 `workspace` 字段**不可靠**，必须先归一化再比较。
 *
 * 这台机器上同一个项目散成了 5 种写法（实测）：
 *   `D:\WorkBuddy工作区\Tool开发\DSH`
 *   `d:\WorkBuddy工作区\Tool开发\DSH`      ← 盘符大小写
 *   `d:\WorkBuddy工作区\Tool开发\DSH`      ← 由 DSH 记录的另一种大小写
 *   `d-WorkBuddy工作区-Tool开发-DSH`       ← WorkBuddy 项目目录的编码形式（盘符 + 短横线）
 *   `D:\WorkBuddy工作区\Tool开发`           ← 父目录（另一个会话在上级目录里开的）
 *
 * 直接 `includes` 比较的后果：按工作区过滤漏掉一半、related 里「同一工作区」这条理由形同虚设、
 * 面板也没法按项目分组。所以统一走这里：
 *
 *   - `normalizeWorkspace(raw)` → 统一分隔符与大小写的**比较键**；
 *   - `projectOf(raw)`          → **项目名**（取最深一段；WorkBuddy 的短横线形式会还原）；
 *   - `matches(cardWs, filter)` → 过滤判定：比较键前缀或项目名命中都算；
 *   - `groupByProject(cards)`   → 面板分组 / 摘要用。
 *
 * 只做字符串推断，**不读文件系统**：卡片可能来自别的机器（同步来的），那边的路径在这里不存在。
 */

/** 统一分隔符（`\` → `/`）、去尾斜杠、折叠重复斜杠。保留大小写。 */
function tidy(raw) {
  return String(raw || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

/** 比较键：在 tidy 基础上统一小写。 */
export function normalizeWorkspace(raw) {
  return tidy(raw).toLowerCase();
}

/** WorkBuddy 项目目录名：`d-WorkBuddy工作区-Tool开发-DSH` → 取最后一段。 */
function decodeWorkbuddyDir(raw) {
  const text = tidy(raw);
  if (text.includes('/')) return null;
  // 盘符 + 短横线编码：形如 d-Some-Folder-Name（至少两段，且首段是单字母盘符）
  const m = /^([a-zA-Z])-(.+)$/.exec(text);
  if (!m) return null;
  const tail = m[2].split('-').filter((s) => s.length > 0);
  if (tail.length === 0) return null;
  return tail[tail.length - 1];
}

/**
 * 项目名：取路径最深一段；WorkBuddy 编码目录还原后再取。
 * 拿不到就用整串（避免出现空分组）。
 */
export function projectOf(raw) {
  const text = tidy(raw);
  if (!text) return '';
  if (text.includes('/')) {
    const parts = text.split('/').filter((s) => s.length > 0);
    return parts[parts.length - 1] || text;
  }
  const decoded = decodeWorkbuddyDir(text);
  return decoded || text;
}

/** 项目键（比较用）：项目名小写。 */
export function projectKeyOf(raw) {
  return projectOf(raw).toLowerCase();
}

/**
 * 过滤判定：`filter` 可以给
 *   - 完整路径（含分隔符）：按**归一化后的前缀**匹配（`D:\a\b` 也能命中 `D:\a\b\c`）；
 *   - 项目名（不含分隔符）：按项目键匹配。
 * @param {string} workspace 卡片上的 workspace 原值
 * @param {string} filter 用户给的过滤值
 */
export function matches(workspace, filter) {
  const want = normalizeWorkspace(filter);
  if (!want) return true;
  const have = normalizeWorkspace(workspace);
  if (have === want) return true;
  if (want.includes('/')) return have.startsWith(want.endsWith('/') ? want : `${want}/`);
  return projectKeyOf(workspace) === want || have.endsWith(`/${want}`);
}

/**
 * 按项目分组。
 * @param {Array<{workspace?: string}>} cards
 * @returns {Array<{project: string, key: string, workspaces: string[], count: number, latest: number}>}
 */
export function groupByProject(cards = []) {
  const map = new Map();
  for (const card of cards) {
    const raw = String(card?.workspace || '');
    const key = projectKeyOf(raw) || '(未记录)';
    let slot = map.get(key);
    if (!slot) {
      slot = { project: projectOf(raw) || '(未记录)', key, workspaces: [], count: 0, latest: 0 };
      map.set(key, slot);
    }
    slot.count += 1;
    slot.latest = Math.max(slot.latest, Number(card?.updatedAt) || 0);
    const canonical = tidy(raw);
    if (canonical && !slot.workspaces.includes(canonical)) slot.workspaces.push(canonical);
  }
  return [...map.values()].sort((a, b) => b.latest - a.latest);
}

/** 项目标签（面板显示用）：同一个项目多种写法时只展示项目名。 */
export function projectLabel(raw) {
  const project = projectOf(raw);
  return project || '(未记录)';
}
