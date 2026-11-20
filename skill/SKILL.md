---
name: session-index
description: 跨会话历史接入与检索。让新会话一次调用就接上 DSH 里全部历史会话的结论，避免重复读取大体积会话文件浪费时间和 token。
whenToUse: 会话开始需要了解项目历史；用户提到「之前 / 上次 / 以前 / 接着 / 继续 / 记得」；要找历史决策、报错结论、某功能之前怎么做的；需要把散落的多个会话串起来。
---

# 跨会话历史接入

你有 `session_index_*` 系列 MCP 工具（共 **17 个**）。所有历史会话已预先建好索引，源会话文件是分帧 zstd 压缩，**不要直接去读 `~/.dsh/sessions` 下的 `.zstd` 文件**——那会重复消耗大量时间和 token。

索引覆盖 DSH 与 WorkBuddy 两个应用的会话，`session_index_*` 的 `app` 参数可过滤 `dsh` / `workbuddy` / `all`。

## 会话开始时（默认动作）

1. 调 `session_index_brief`（`limit` 5~8、`maxChars` 3000）拿一份跨会话结论速览，一次接上全部历史。
2. 当前任务主题明确时，改用 `session_index_brief` 带 `query`（例如 `query: tokenhub`），只拿相关会话的结论。
3. 客户端支持 prompts 时，直接注入 `session-context` 提示词即可完成以上两步。

## 按需深入，逐级放大

| 需求 | 工具 |
|---|---|
| 这事之前还在哪些会话里处理过 | `session_index_related`（传 sessionId 或 query，返回关联理由） |
| 这个会话是不是 compact / subagent 派生出来的 | `session_index_thread`（上游祖先 + 下游派生 + 同源兄弟） |
| 有哪些会话、标题、时间 | `session_index_list` |
| 找具体某句话 / 报错 / 命令 | `session_index_search`（默认语义检索，只返回命中片段） |
| 看某个会话脉络 | `session_index_get` 不传 seqs（返回骨架） |
| 取完整原文 | `session_index_get` 传 seqs 或 seqFrom/seqTo，并控制 `maxChars` |
| 记住一条跨会话结论 | `session_index_remember`（带类型/标签/重要度） |
| 找回记过的结论 | `session_index_recall`（时间衰减排序） |
| 归档 / 删除记忆 | `session_index_forget`（默认归档，不物理删除） |
| 查看索引与自动维护状态 | `session_index_status` |
| **我还有什么没做完 / 遗留事项** | **`session_index_todos`**（扫最近会话抽 TODO/待办/下一步，排除「已完成」语气，按项目分组） |
| **接着上次继续干（要一段可直接粘的上下文）** | **`session_index_resume`**（目标/结论/未完成/涉及路径/关键词/相关记忆，一次给全） |
| **索引是否健康 / 清掉孤儿与残留** | **`session_index_doctor`**（meta/分片/卡片一致性、孤儿分片、备份堆积；`fix:true` 只清安全项） |
| 手动触发增量刷新 | `session_index_refresh` |
| 重新生成分发包 | `session_index_package` |
| 管理可选向量索引 | `session_index_vectors` |
| 把会话整理成文档投到思源桥「待入库」 | `session_index_stage`（两步确认：先预览拿 `confirmWith`，回传才投递；**绝不自动写笔记库**） |

## 铁律

- 顺序是 **status → brief → related/thread → search → get**；不要一上来就取全文或全库大范围搜索。
- 用户问「还有什么没做完 / 遗留 / 下一步」→ 用 **`session_index_todos`**，别自己翻会话。
- 用户说「接着上次那个活继续」→ 用 **`session_index_resume`** 拿上下文包，比 brief 更直接。
- 面板或工具报「索引/数据不对」→ 先跑 **`session_index_doctor`**，它会把问题定位到具体文件；
  要清理再加 `fix: true`。
- `session_index_search` 默认**按会话聚合**（同一会话只给最相关的一段，其余 seq 收在 `moreSeqs`）——
  这是为了省 token；要逐条看原始命中传 `group: false`。
- 按工作区过滤时不必写全路径：`workspace: "DSH"` 就能命中该项目**所有路径写法**
  （盘符大小写、斜杠、WorkBuddy 的 `d-WorkBuddy工作区-…-DSH` 编码目录都算同一个项目）。
- `session_index_search` 默认排除系统注入的时间/上下文快照，只有排查框架行为时才加 `includeSystem: true`；`mode: keyword` 可切回精确匹配。
- 刚结束的会话查不到时无需手动干预：文件事件会自动纳入索引（数秒内）。确需立即同步才调 `session_index_refresh`（增量，通常 < 1 秒）。
- 会话卡里的结论是规则抽取的，可能不完整；涉及关键决策时用 `search` / `get` 回原文核对。
- 除 `remember` / `forget` 写入长期记忆库外，所有工具只读索引，不会修改 DSH 的任何原始会话。

## 安装

**不需要手工跑安装脚本**（`install.mjs` / `install.cmd` 已在 v2.5.3 移除，仓库里没有这些文件）。

1. DSH → **插件页** → 粘贴仓库地址 `https://github.com/Lau-Jin/DSH` → 安装 → **完全退出 DSH 再打开**（最小化不算）。
   或命令行：`cd ~/.dsh/profiles/desktop && pnpm add dsh-session-index-lau`。
2. 装完自动发生三件事：包内 `cordis.patch.yml` 挂上 MCP stdio 客户端（本 Skill 的 17 个工具即可用）、
   宿主半身把 `server.mjs` 路径写进 `server-path.txt`、本文件被自动装到 `%USERPROFILE%\.dsh/skills\session-index\SKILL.md`。
3. 前置：Node ≥ 22.15（需要 `zlib.zstdDecompressSync`；插件页安装会自动挑 DSH 自带的 Node）。

如果工具不存在，按顺序查：「MCP 与技能」里 `session-index` 服务是否启用 → 是否重启过 DSH →
`~/.dsh/session-index/host-half.log` 有没有 `apply` 记录。技能文件本身也可手工复制到上述路径。

装上之后还有两个给人用的入口：侧栏「会话检索」面板（走 MCP 服务进程开的本地只读 HTTP
`127.0.0.1:8799`），以及聊天里的斜杠命令 `/session-index list|search|card|status`——
与本 Skill 的工具共用同一套查询实现，口径一致。
