---
name: session-index
description: 跨会话历史接入与检索。让新会话一次调用就接上 DSH 里全部历史会话的结论，避免重复读取大体积会话文件浪费时间和 token。
whenToUse: 会话开始需要了解项目历史；用户提到「之前 / 上次 / 以前 / 接着 / 继续 / 记得」；要找历史决策、报错结论、某功能之前怎么做的；需要把散落的多个会话串起来。
---

# 跨会话历史接入

你有 `session_index_*` 系列 MCP 工具（共 **13 个**）。所有历史会话已预先建好索引，源会话文件是分帧 zstd 压缩，**不要直接去读 `~/.dsh/sessions` 下的 `.zstd` 文件**——那会重复消耗大量时间和 token。

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
| 手动触发增量刷新 | `session_index_refresh` |
| 重新生成分发包 | `session_index_package` |
| 管理可选向量索引 | `session_index_vectors` |

## 铁律

- 顺序是 **status → brief → related/thread → search → get**；不要一上来就取全文或全库大范围搜索。
- `session_index_search` 默认排除系统注入的时间/上下文快照，只有排查框架行为时才加 `includeSystem: true`；`mode: keyword` 可切回精确匹配。
- 刚结束的会话查不到时无需手动干预：文件事件会自动纳入索引（数秒内）。确需立即同步才调 `session_index_refresh`（增量，通常 < 1 秒）。
- 会话卡里的结论是规则抽取的，可能不完整；涉及关键决策时用 `search` / `get` 回原文核对。
- 除 `remember` / `forget` 写入长期记忆库外，所有工具只读索引，不会修改 DSH 的任何原始会话。

## 安装

从仓库拉取后运行 `node install.mjs`（Windows 可双击 `install.cmd`）会自动把本 Skill 装到 `%USERPROFILE%\.dsh\skills\session-index\SKILL.md`，同时注册 `session-index` MCP server。

也可单独导入：在 DSH「MCP 与技能」→ Skills 里导入 `skill/` 目录，或复制本文件到上述路径；前提是已启用 `session-index` MCP server，否则没有对应工具。
