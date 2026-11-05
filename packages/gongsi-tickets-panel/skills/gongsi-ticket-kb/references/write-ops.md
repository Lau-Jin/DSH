# 写操作细则（回写 / 工时 / 完成 / 建单 / 转派 / 任务 / 沉淀 / 附件）

> gongsi-ticket-kb 参考文件。内容对应 SKILL.md 的 **§2 Step 7~13** 与 **§10 建单示例**。
> **全部是会落到共享业务系统、产生不可撤回副作用的写操作。**
> SKILL.md §1 铁律 6 仍然生效：**先把「拟写入的内容」摆出来给用户看，用户点头才执行。**
> 目录型资源基址 = `C:/Users/Administrator/.dsh/skills/gongsi-ticket-kb`，本文件相对路径 `references/write-ops.md`。

---

### Step 7 — 回写工单（仅当用户明确要求）

| 要求 | 调用 |
|------|------|
| 追加处理说明 | `ticket_add_ticket_comment(ticketId=..., content=..., idempotencyKey="<工单号>-<主题>-<日期>-v1")` |
| 平台 AI 追问 | `ticket_ask_ai(ticketId, question)` → **立即返回**，必须用 `ticket_get_ai_chat` 轮询 `status`（processing→done/failed） |

> ⚠️ `ticket_add_ticket_comment` 写入的是**工单关联任务的过程日志**；`idempotencyKey` 必传，否则重复提交会产生重复日志。
> ⚠️ `ticket_get_ai_chat` 若报"无权限访问该工单的 AI 会话（会话属于其他用户）"，说明该工单的 AI 会话是**别人**发起的，不可读 —— 放弃这条路径，改为自己在 Step 4~5 检索。
> ⚠️ **默认不回写。** 用户说"追加到工单/写进工单"才写。

### Step 8 — 记录工时

**前置**：工单详情里的 `taskId`（不是 `id`）就是工时挂在哪个任务上。工单详情返回 **`id`（工单ID）** 和 **`taskId`（关联任务ID）** 两个不同的数字，别混。

```
task_add_worklog(taskId, workDate, hours, remark?, progress?, isOvertime?)
```

**三个副作用，必须提前知道**

| 副作用 | 说明 |
|--------|------|
| 自动流转任务状态 | 写入工时会**自动把「新建」任务转为「进行中」** |
| 覆盖任务进度 | 传了 `progress` 就会**同步覆盖**任务当前进度 |
| 回填开始时间 | 传了 `progress` 还会**回填任务的实际开始时间** |

**三条预检，缺一不可 —— 但脚本一条命令就跑完了**

```bash
node scripts/worklog-precheck.mjs <taskId> <YYYY-MM-DD> [hours] [--remark "..."]
```

脚本依次做：
```
① calendar_is_workday(date)                     → 非工作日必须 isOvertime=true
② task_list_my_worklogs(startDate=date, endDate=date)  → 工作日跨任务正常工时合计 ≤ 8h
③ task_list_task_worklogs(taskId)               → 同任务同日期已有记录？改用 task_update_worklog
```
并输出**可直接用的 `task_add_worklog(...)` 参数**、任务当前状态、以及"记工会把任务从「新建」推到「进行中」"的副作用提示。
**退出码 0 = 可以 add，1 = 不能**（当天超 8h / 同任务同日期已有记录）。

> ⚠️ **预检脚本是只读的，它不写任何东西。** 是否执行仍由人决定 —— 写操作走工具层，先确认再写。

**其它约束**
- `workDate` = `YYYY-MM-DD`（本地日历日，不涉及时区）；`hours` 支持小数（0.5 / 2.5）；`remark` ≤ 500 字
- **同任务 + 同日期 + 同类型（正常/加班）唯一** → 重复添加报冲突错误，此时**改那条**而不是再添加一条
- 改已有工时用 `task_update_worklog(taskId, worklogId, workDate, hours, ...)`：
  非管理员只能改**本人**的工时，且须**创建后 3 天内**；改到已被占用的日期同样冲突

> ⚠️ **默认不记。** 用户说"记一下工时/记 N 小时"才写，并先报出：日期、小时数、是否加班、备注、是否会改动任务进度。

### Step 9 — 完成工单

```
ticket_update_ticket_status(ticketId, action="complete", comment="<处理结论>")
```

**前置状态**：`assigned → processing → completed`。工单还在 `assigned` 要先
`ticket_update_ticket_status(ticketId, action="start")` 或 `ticket_start_ticket(ticketId)`。

**副作用**：`complete` 会**把处理结论回写到关联任务的日志**（根因/解决方案结论），**这一步无法撤回**。

**处理结论怎么写**：直接复用 Step 5 的分析产出 —— 结论 / 根因 / 依据 / 处置动作，去掉过程性描述。
**不要**把知识库引用整段搬进去，结论要能独立看懂。

**原因分析是关单的前置（插件工具层）**：服务端**不给原因分析就不让关单** ——
工单的任务上必须先有一条 **`root_cause` 类型**的任务日志，否则 `complete` 直接报
「请先填写原因分析（任务日志类型：原因分析）」。
面板把这一步拆成了**独立的一步**：行里依次是「开始处理 → 原因分析 → 确认完成」，
「原因分析」一个框、单独存成 `root_cause` 日志；「确认完成」**不带输入框**，
而且**只有原因分析存好之后才会出现**。
Agent 侧 `gongsi_ticket_action(action="complete")` 的 `rootCause` 字段同理：
给了就先写成日志再关单，不给就把任务上已记录的原因分析读回来当结论；读不到就**不关单**。
服务端不认 `root_cause` 这个类型时，同一段文字会退回写成一条处理说明，内容不会丢。

**工单完成 ≠ 任务完成**：两者是两条链。
- 关联任务状态用 `task_transition_task(taskId, toStatus)` 单独流转
- 任务若还停在「新建」，Step 8 记工时会自动推到「进行中」

> ⚠️ **默认不完成。** 先把拟提交的 `comment` 全文给用户看，用户明确说"完成工单"才调。
> ⚠️ 完成前建议先确认根因确实已闭环（否则结论会变成"处理结论"落到任务日志，日后追责）。
> ⚠️ 若业务规则要求"先指派才能开始"而报"先指派"，说明工单还没指派给当前用户 —— 先 `ticket_claim_ticket` 或请用户指派。

### Step 10 — 主动建单 / 认领 / 转派

**建单** `ticket_create_ticket(title, description, schoolId, productId, issueType, priority?, productVersionId?)`

五个必填项缺一就报错，ID 一律从 `meta_*` 取（见 `references/kb-map.md` §6 字典速查）：

```
title         "统一身份认证同步学生失败排查"
description   现象 + 报错原文 + 影响面 + 已做动作
schoolId      29              # meta_list_schools
productId     38              # meta_list_products
issueType     "data_investigate"   # ⚠️ 要 code，不是 id
productVersionId  568         # meta_list_product_versions，可选
priority      "high"          # 固定枚举 high/medium/normal
```

**认领** `ticket_claim_ticket(ticketId)` —— 把当前用户设为处理人。
**转派** `ticket_assign_ticket(ticketId, ownerUserId)` —— **原处理人会自动转为协办**，不需要另外维护协办人。

> ⚠️ **默认不建单。** 用户说"提个单/反馈一下"才建，且先把 title/description/各 ID 摆出来确认。

### Step 11 — 任务生命周期

| 动作 | 工具 | 要点 |
|------|------|------|
| 建任务 | `task_create_task(title, dueTime, ...)` | 必填 **title + dueTime(YYYY-MM-DD)**；`ownerUserId` 不传则走迭代默认负责人兜底；`parentTaskId` 建子任务（调用者须是父任务关联人员） |
| 改任务 | `task_update_task(taskId, ...)` | 可改负责人/截止/预估工时/标签/描述；**`status` 改不了** |
| 流转状态 | `task_transition_task(taskId, toStatus, ...)` | `toStatus` 用**中文枚举**；延期带 `delayReason`，取消带 `cancelReason`，待评审带 `reviewUserId`+`reviewDueTime` |
| 协作人 | `task_update_task_assignees(taskId, action, userId, role?)` | `action` = add / remove / updateRole |
| 过程日志 | `task_add_task_log(taskId, content, logType?, idempotencyKey?)` | 与工时是两回事，日志不受 8h/工作日限制 |
| 删工时 | `task_delete_worklog(taskId, worklogId)` | 仅本人 + **3 天窗口** |
| 我的任务 | `task_list_my_tasks(q, page, limit, status, overdue, productId, iterationId)` | 描述被截断到 500 字符，超长正文会被**静默丢弃** |

> ⚠️ `task_update_task` 的 `status` 参数**无效**，状态只能走 `task_transition_task`。
> ⚠️ `task_list_my_tasks` 的 description 对超长任务会整段丢失（真实正文可达 23 万字符）—— 要全文用 `task_get_task_detail`。

### Step 12 — 知识沉淀（工单 → KB 案例）

公司惯例：KB 6 的文件夹 **[99] AI维护** 是工单知识沉淀区，现有 12 篇全部 `origin_type=ticket_kb`。

**标题惯例**：`【学校名】现象——根因 处理案例`

参考现有标题：
- 【四川水利职业技术学院】统一身份认证登录提示"无权查看其他用户的第三方绑定信息"——sys_three_user.id 与 sys_user.id 不一致（角色与身份数据冲突）处理案例
- 【成都体育学院】统一身份认证与服务中台手机号不一致（同步覆盖/数据源问题）案例
- 统一身份认证快速新增/同步学生未新增——数据集视图配置错误（新生转在校生视图）导致学生同步缺失

**正文惯例**：现象 → 根因 → 机理说明 → 排除项（AI 初判但非根因的，可作同类排查参考）→ 定位过程（逐步导航路径）→ 处置 → 回归。

> ⚠️ **MCP 的知识库是纯只读的** —— 8 个 `kb_*` 全是读，**没有写文档的工具**。
> 所以"沉淀"只有两条路：
> **(a)** 把成稿案例文本给用户，由用户在 PC 端 / 语雀录入 KB；
> **(b)** 先 `ticket_add_ticket_comment` 写进工单处理说明，再由知识库负责人转存。
> **不要承诺"我帮你写进知识库"。**

### Step 13 — 上传附件

```
biz_upload_attachment(fileName, fileBase64, mimeType?, ticketId?, businessType?, businessId?, description?)
```

- **≤10MB**，超了走 PC 端（这个工具刻意没实现分片协议）
- **工单附件实际挂在底层任务上** —— 工单场景传 `ticketId`（服务端自动换算）；其它场景传 `businessType`(task/requirement/defect) + `businessId`
- 扩展名白名单与 PC 端一致
- `fileBase64` 传纯 base64（不带 `data:xxx;base64,` 前缀）

> ⚠️ 默认不上传。产物落盘后，**先问用户要不要挂到工单上**再传。

---

## 10. 新建工单示例（参数直接可用）

以 FB202610270001 为模板，反推一份建单参数：

```
ticket_create_ticket(
  title="统一身份认证同步学生失败排查（班级列表中无法查询到）",
  description="现象：2026-10-29 同步批次失败 96 条 / 82 个班级，100% 同一错误。
报错：学生身上的班级信息在班级列表中无法查询到（UUserInfoService.saveStudent:207）。
影响：涉 2012~2018 级学生，同步批次 14:44~14:58，在读生无影响。
已定位：KB 未检索到该报错专项文档；按表模型，同步学生班级数据依赖 class_info 等表，
        中台侧班级主数据缺失导致学生侧引用悬空。",
  schoolId=29,                       # 四川传媒学院
  productId=38,                      # 统一身份认证
  productVersionId=568,              # V2.8.7 2 -FIX-260908
  issueType="data_investigate",      # ⚠️ code，不是 id
  priority="high"
)
```

建单后 → `ticket_assign_ticket(ticketId, ownerUserId=65)` 转派 → `ticket_start_ticket(ticketId)` 开始处理。

---
