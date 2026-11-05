# 工具速查与已知坑

> gongsi-ticket-kb 参考文件。内容对应 SKILL.md 的 **§4 工具速查** 与 **§11 已知坑**。
> 铁律、输出模板、只读主流程仍在 SKILL.md 里，本文件是**按需查阅**的扩展。
> 目录型资源基址 = `C:/Users/Administrator/.dsh/skills/gongsi-ticket-kb`，本文件相对路径 `references/tool-map.md`。

---

## 4. 工具速查（全部 45 个）

### 4.1 工单 ticket（13）

| 用途 | 工具 | 关键参数 |
|------|------|----------|
| 取工单详情 | `ticket_get_ticket_detail` | `ticketNo`（推荐）/ `ticketId`；返回 `id`(工单) 与 `taskId`(任务) |
| 列我的工单 | `ticket_list_my_tickets` | `limit ≤ 40`，`keyword`，`ticketStatus`, `issueType` |
| 工单附件 | `ticket_list_ticket_attachments` | `ticketId` |
| 追加工单说明 | `ticket_add_ticket_comment` | `ticketId`, `content`, `idempotencyKey` |
| **建单** | `ticket_create_ticket` | `title`, `description`, `schoolId`, `productId`, `issueType`(code) 必填 |
| **认领** | `ticket_claim_ticket` | `ticketId` |
| **转派** | `ticket_assign_ticket` | `ticketId`, `ownerUserId`；原处理人自动转协办 |
| 开始处理 | `ticket_start_ticket` | `ticketId` |
| 推进状态 | `ticket_update_ticket_status` | `ticketId`, `action`=start/complete/cancel, `comment`/`reason` |
| 平台 AI 追问 | `ticket_ask_ai` | `ticketId`, `question`；**立即返回**，需轮询 |
| 轮询 AI 回复 | `ticket_get_ai_chat` | `ticketId`, `limit ≤ 20`, `sinceUserMessageId`；`status`=idle/processing/done/failed |
| **重跑 AI 分析** | `ticket_reanalyze_ai` | `ticketId`, `force`；轮询工单详情的 `aiAnalysisStatus` |
| 工单问题类型 | `ticket_list_issue_types` | 取 `code` |

### 4.2 任务 task（15）

| 用途 | 工具 | 关键参数 |
|------|------|----------|
| 查任务详情 | `task_get_task_detail` | `taskId`, `logLimit ≤ 100`, `worklogLimit ≤ 100` |
| **建任务** | `task_create_task` | `title`, `dueTime` 必填；`parentTaskId` 建子任务 |
| **改任务** | `task_update_task` | `taskId` + 可改 `ownerUserId`/`dueTime`/`description`/`tags`…；**status 不可改** |
| **流转状态** | `task_transition_task` | `taskId`, `toStatus`（**中文枚举**）, `delayReason`/`cancelReason`/`reviewUserId` |
| **协作人增删改** | `task_update_task_assignees` | `taskId`, `action`=add/remove/updateRole, `userId`, `role` |
| 我的任务 | `task_list_my_tasks` | `q`, `page`, `limit`, `status`, `overdue`, `productId`, `iterationId` |
| 任务类型树 | `task_list_task_types` | 取 `typeId` |
| **记工时** | `task_add_worklog` | `taskId`, `workDate`(YYYY-MM-DD), `hours`(可小数), `remark`(≤500), `progress`(0-100), `isOvertime` |
| 查任务工时 | `task_list_task_worklogs` | `taskId`, `limit ≤ 50`, `offset`（按日期倒序） |
| 查我的工时 | `task_list_my_worklogs` | `taskId`, `startDate`, `endDate`, `page` |
| **改工时** | `task_update_worklog` | `taskId`, `worklogId`, `workDate`, `hours`；本人 + 3 天内 |
| **删工时** | `task_delete_worklog` | `taskId`, `worklogId`；本人 + 3 天窗口 |
| **任务过程日志** | `task_add_task_log` | `taskId`, `content`, `logType`, `idempotencyKey` |
| 查过程日志 | `task_list_task_logs` | `taskId`, `limit`, `logType` |
| 任务附件 | `task_list_task_attachments` | `taskId`, `limit ≤ 50`, `offset` |

### 4.3 知识库 kb（8，**全部只读**）

| 用途 | 工具 | 关键参数 |
|------|------|----------|
| **向量检索（主力）** | `kb_search` | `query`（必填）, `top_k ≤ 10`（建议 8）, `kb_ids`（可选） |
| 读文档全文 | `kb_get_document` | `doc_id = items[].source_id`, `max_chars ≤ 15000` |
| 读片段上下文 | `kb_get_context` | `doc_id`, `chunk_index`, `surrounding_count`（默认 2） |
| 列知识库 | `kb_list_my_bases` | `limit ≤ 100`, `keyword` |
| 列库内文档 | `kb_list_documents` | `kb_id`（必填）, `keyword`, `folder_id`, `limit ≤ 100` |
| 库内文件夹树 | `kb_list_folders` | `kb_id` |
| 文档版本历史 | `kb_list_doc_versions` | `doc_id`；**仅自建文档** |
| 文档暂存区 diff | `kb_get_diff` | `doc_id`；**仅自建文档**，无暂存时 `has_staging=false` |

### 4.4 元数据 meta（6，字典）

| 用途 | 工具 | 关键参数 |
|------|------|----------|
| 学校/项目 | `meta_list_schools` | `keyword`, `limit ≤ 200` → `schoolId` |
| 产品/系统 | `meta_list_products` | `keyword`, `type`, `limit ≤ 200` → `productId` |
| 产品版本 | `meta_list_product_versions` | `productId`（必填）→ `productVersionId` |
| 功能模块树 | `meta_list_product_modules` | `productId` 或 `libraryId` **至少一个** → `moduleId` |
| 迭代列表 | `meta_list_iterations` | `keyword`, `schoolId`, `productId` → `iterationId`/`areaKey` |
| 用户列表 | `meta_list_users` | `keyword` → `ownerUserId`/`assigneeId`；**脱敏** |

### 4.5 其他（3）

| 用途 | 工具 | 关键参数 |
|------|------|----------|
| **上传附件** | `biz_upload_attachment` | `fileName`, `fileBase64` 必填；`ticketId` 或 `businessType`+`businessId`；≤10MB |
| 判断工作日 | `calendar_is_workday` | `date`(YYYY-MM-DD) |
| 缺陷附件 | `defect_list_defect_attachments` | `defectId`（仅此一个缺陷接口） |

### 4.6 MCP 直连兜底（工具没挂成可调用工具时）

**什么时候用**：可调用工具列表里找不到 `ticket_get_ticket_detail` / `kb_search` 等 45 个 gongsi 工具，
但 `mcp_health` 显示服务端 `ok: true, toolCount: 45` —— 说明是**本地工具注册层**没注入，
不是服务端、账号或权限问题。**此时绝不能改用 web_fetch 或凭记忆作答。**

**怎么调**：技能自带 `scripts/mcp-http-call.mjs`，直连 `https://yanfa.scedu.tech/api/mcp`
说 MCP 协议（streamable-http：`initialize` → `notifications/initialized` → `tools/call`），
绕开工具注册层，效果与原生工具一致。

```bash
# 1) 写调用文件
#    calls.json = { "calls": [ { "tool": "ticket_get_ticket_detail",
#                                "args": { "ticketNo": "FB202610300001" } } ] }
# 2) 跑（每个调用结果单独写到 mcp-out/<tool>-<序号>.json）
node scripts/mcp-http-call.mjs calls.json --out mcp-out
```

| 要点 | 说明 |
|------|------|
| 连接信息 | **自动**从 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的 `mcp-gongsi` 段读端点与令牌；可用 `GONGSI_MCP_URL` / `GONGSI_MCP_TOKEN` 覆盖。**不要把令牌硬编码进脚本，更不要写进工单正文** |
| 读结果 | `structuredContent` 是结构化结果；`content[].text` 是同一份内容的 JSON 字符串 |
| 响应格式 | 服务端可能回纯 JSON，也可能回 SSE（`text/event-stream`）—— 脚本两种都能解析 |
| 写操作 | `ticket_add_ticket_comment` / `task_add_worklog` / `ticket_update_ticket_status` 等**同样适用**；但 SKILL.md §1 铁律 6「先确认再写」照样生效（细则见 `references/write-ops.md`） |
| 副作用 | 兜底脚本对共享系统的写入与原生 MCP 工具**完全一样**，一样不可撤回 |

> ⚠️ 附带坑：`pwsh` 在 workspace-write 沙箱下曾以 `0xC0000142`(DLL init failed) 直接崩掉、
> 无任何输出 —— 用 `danger-full-access` 重试同一条命令即可恢复。

---

## 11. 已知坑

| 坑 | 表现 | 对策 |
|----|------|------|
| 分片 ID 当文档 ID 用 | `kb_get_document` 报"无权限访问此文档" | 传 `items[].source_id` |
| AI 生成问答当原文 | 引用的"知识"其实是 AI 编的 | `is_qa=true` 一律先核对原文 |
| `limit` 超限 | `-32006` 响应超 64KB | `ticket_list_my_tickets` limit ≤ 40 |
| 片段被截断 | 结论缺上下文 | `contentTruncated=true` → `kb_get_context` 补齐 |
| AI 会话非本人发起 | `ticket_get_ai_chat` 无权限 | 放弃该路径，自己检索 |
| 检索词太笼统 | 召回一堆不相干 | 拆成"报错片段""表名""动作"多轮搜 |
| 工单描述太短 | 检索词无方向 | 先看附件截图与处理记录 |
| **工单ID 与任务ID 混淆** | 工时记到错的任务上 | 工单详情里 `id`=工单ID、`taskId`=关联任务ID，**两个不同的数** |
| **记工时撞日期** | 同任务同日期同类型报冲突 | 先 `task_list_task_worklogs` 查；有就改那条，别重复添加 |
| **非工作日记正常工时** | 报"非工作日必须记为加班" | `calendar_is_workday` 先判，`isOvertime=true` |
| **工作日超 8h** | 跨任务合计超限被拒 | `task_list_my_worklogs` 查当天已有工时再算 |
| **任务状态被工时带着变** | 记完工时任务从「新建」变「进行中」 | 记工时前先报出这个副作用 |
| **complete 结论不可撤回** | 结论已落到任务日志 | 执行前必须让用户确认结论全文 |
| **字段名 `toStatus`** | 传 `status` 被拒 | `task_transition_task` 用 `toStatus`，且用**中文**枚举 |
| **issueType 要 code** | 建单报参数错误 | `ticket_list_issue_types` 取 `code`（如 `data_investigate`），不是 `id` |
| **知识库没有写工具** | 想沉淀案例却找不到写接口 | 8 个 `kb_*` 全是读；成稿给用户，由用户录入 |
| **版本/diff 只对自建文档有效** | 对 yuque 同步文档报"文档不存在或已删除" | `kb_list_doc_versions` / `kb_get_diff` 仅适用于 `origin_type=ticket_kb`/`manual` 的文档（例：6487 统一身份认证 FAQ 是 yuque 源，786 是自建，可用） |
| **task_update_task 改不了状态** | 传了 status 无效 | 状态只能走 `task_transition_task` |
| **task_list_my_tasks 长正文丢失** | 描述空/被截 | description 截断 500 字符，超长任务正文（可达 23 万字符）会被**静默丢弃**；要全文用 `task_get_task_detail` |
| **工单附件其实挂任务上** | 传 businessType=task 找不到 | 工单场景传 `ticketId`，服务端自动换算到任务 |
| **上传超 10MB 失败** | 附件没挂上 | 该工具无分片协议，走 PC 端上传 |
| **MCP 工具没挂成可调用工具** | 工具列表里根本没有 `ticket_*` / `kb_*` | 先 `mcp_health` 确认服务端 `ok:true, toolCount:45`，再走 **§4.6 直连兜底**；**不要**改用 web_fetch 或凭记忆作答 |
| **`kb_search` 也撞 64KB 预算** | 报 `-32006`"工具 kb_search 的响应体 xx KB 超过对外通道预算" | 响应大小取决于**命中分片的内容**（图片识别块可以很大），**不是条数决定的** —— 查询词越短命中越"全"反而越容易超。服务端自己给的建议就是**收敛 top_k**；`scripts/kb-digest.mjs` 已内置自动折半重试 |
| **工具层错误被当成空结果** | 封装只判了 JSON-RPC 层 error，没判 `isError:true` | MCP 工具级错误是 `isError:true` + text 内容，**不是** JSON-RPC error。不显式判掉 → 错误信封被当成正常数据 → 报"0 条命中"，把人带进"KB 没查到"的错误结论（`scripts/lib/mcp.mjs` 已修） |
| **PowerShell 写的 JSON 带 BOM** | `JSON.parse` 报 `Unexpected token '﻿'` | `Set-Content -Encoding UTF8` 会写 BOM；读 JSON 时先 `.replace(/^﻿/, '')`（`scripts/mcp-http-call.mjs` 已修） |
| **工单状态不一定是 `assigned`** | 新建工单可能是 `created` | 完成前先 `action="start"`；§Step 9 的链路 `assigned→processing→completed` 对 `created` 要多走一步 start |
| **`meta_list_products` 返回不全** | 不带 keyword 时 `total:66` 却只回 45 项 | 带 keyword 精确查；查不到就当"当前账号不可见"，**别硬套产品名** |
| **工单描述写"已处理"但平台无记录** | 工单状态还是 `created`、任务「新建」、0 工时、只有 AI 日志 | 描述不是处理记录；闭环前先向发起人核实"已处理"到底做了什么 |
| **pwsh 在沙箱里崩** | workspace-write 下 `0xC0000142` 且无任何输出 | 用 `danger-full-access` 重试同一条命令 |
