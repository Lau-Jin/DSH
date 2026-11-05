# 公司工单面板 · gongsi tickets panel

DeepSeek Harness（DSH）插件：在左侧栏显示 gongsi MCP 服务上的工单，支持筛选、分页，以及评论 / 记工时 / 分派 / 开始处理 / 确认完成。

当前版本：**1.0.9**（分发件 `local-gongsi-tickets-panel-1.0.9.tgz`）

## 功能

| 能力 | 说明 |
|---|---|
| 全部工单 / 我的工单 | 两个标签页；「我的」按当前 API Key 自动识别的身份过滤 |
| 未分派标识 | 没有处理人的工单，行首状态标签旁挂一个**红色**的「未分派」标签（详情页头部同样有） |
| 筛选 | 关键字、状态、问题类型（服务端筛选）；优先级、学校、创建人（全量数据客户端筛选） |
| 分页 | 默认每页 15 条，可在「配置」里改（1–40） |
| 评论 | 支持直接 **Ctrl+V 粘贴截图**，图片随评论一起上传为工单附件 |
| 记工时 | 记到底层任务上，支持日期、小时、备注、加班标记 |
| 分派 | **一个框**干两件事：输入姓名即搜，选中即定处理人；标题、输入框、按钮在**同一行**；下拉列表贴着面板内缘自动向上展开 |
| 开始处理 / 原因分析 / 确认完成 | 只在自己负责的工单上出现，且关单那两步**互斥**：还没有原因分析 → 只显示**原因分析**（一个框，存成一条 `root_cause` 任务日志）；存好之后**原因分析收起**，只显示**确认完成**（不用填内容）—— 服务端不给原因分析就不让关单 |
| 详情 | 点击整行进入：问题描述、结论、工时汇总、附件、处理记录（**描述和记录里的截图直接在面板内放大查看**） |
| 分享 | 每行右侧一个「分享」：点一下复制该工单在管理台的链接（`?tab=ticket-detail&ticketId=…`，打开就是这条工单）；详情页头部也有一个 |
| 引用 | 每行一个「引用」：新开一个会话，输入框里只有一行 `/gongsi-ticket <工单号>`（技能标签），接着写自己排查到的信息即可 |
| 新建工单 | 独立标签页，含图片粘贴 |

同时向 Agent 提供四个工具：`gongsi_tickets`（读）、`gongsi_ticket_action`（写）、`gongsi_create_ticket`（建单）、`gongsi_tickets_meta`（字典）。

### 内置的两个技能

插件自带两个技能，装好即可在输入框用 `/` 引用，**不需要另外安装**：

| 技能 | 作用 |
|---|---|
| `gongsi-ticket` | 以工单号为锚点的**三段式**分析：① 结合工单和知识库给出「**下一步怎么查 + 需要你提供什么证据**」（不复述工单详情）→ ② 等你的证据再定位根因 → ③ 定论。**回写由你发起**，未明确要求不提议、不执行 |
| `gongsi-ticket-kb` | 工单 + 公司知识库联合答复：`kb_search` 检索、核对原文、带出处输出（含 `scripts/` 与 `references/`） |

`gongsi-ticket-kb` 是从技能目录**整包复制**进来的（`skills/gongsi-ticket-kb/`），包括 `SKILL.md`、`references/`、`scripts/`。
如果对方机器上已经有同名技能（`~/.dsh/skills/gongsi-ticket-kb`），**本机那份优先**，插件自带的会自动让位，不会覆盖或遮蔽对方更新过的版本。

技能脚本的凭据读取顺序：环境变量 `GONGSI_MCP_URL` / `GONGSI_MCP_TOKEN` → 本机 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的 `mcp-gongsi` 段。所以对方用自己的 Key 即可，包里不含任何密钥。

### 「引用」之后为什么快

引用出来的新会话要拿到「工单事实 + 知识库依据」。如果分两步走 —— 先读工单、再想检索词、再检索 ——
中间那次推理会占掉一整个模型回合，这就是以前响应慢的原因。

`gongsi-ticket-kb` 的 `scripts/triage.mjs` 带 `--auto`：**脚本自己从工单正文提炼检索式**，于是流程塌缩成一条命令：

```bash
node "<gongsi-ticket-kb 目录>/scripts/triage.mjs" <工单号> --auto
```

≈3 秒，一次拿到：工单事实表 + 状态判读 + 它用过的检索式 + 带出处的知识库引用块。
`gongsi-ticket` 技能会把这台机器上**可执行的绝对路径**直接写进技能正文，Agent 复制粘贴即可。

自动提炼只是初稿，脚本会把检索式和工单事实表打在**同一份输出**里 —— 词不对时补一轮检索不用重新读工单。

## 安装

前置：DSH `>= 0.2.1-rc.3`，Node `>= 20`。

> **依赖怎么来（1.0.6 起变了）**：本包**不再把 `node_modules` 打进 tarball**，依赖改由 pnpm 统一解析：
> `@deepseek-ai/schemastery@3.18.5`、`@deepseek-ai/cosmokit@1.8.6`、`@standard-schema/spec@1.1.0`。
> 这三个版本和 DSH 自带插件用的**完全一致**（`dsh-tool-subagent` 等也用 `~3.18.5`），
> 对方机器上通常本来就有 —— pnpm 的 store 和 profile 的 lockfile 里都躺着 —— 所以装的时候**多半一个字节都不用下载**。
>
> 为什么要改：老版本用 `bundleDependencies` 把依赖塞进包里，tarball 里就多出一个**实体目录**
> `node_modules/@deepseek-ai/schemastery`；而 pnpm 自己装依赖时在同一路径放的是**软链**。
> 两者类型不一致，pnpm 搬目录时直接拒绝，报
> `ERR_PNPM_LINKING_FAILED Cannot overwrite directory '...' with non-directory '...'` —— **覆盖安装必现**，
> 机器上装过一次之后再装 tarball 就中招。现在包里没有 `node_modules`，这条冲突从根上没了。

### 方式一：从 Gitee 仓库直接安装（推荐，仓库根目录就是这个包）

```
plugin_manager install_bundle target="git+ssh://git@gitee.com/wumingys/gdcj.git"
```

仓库根目录就是插件包（`package.json` 在根上），所以这条命令装出来的就是本插件。
对方机器上要有 **SSH 私钥**（本仓库是私有的）：把公钥加到 Gitee 的「SSH 公钥」里即可，
或者改用下面的 HTTPS 形式：

```
plugin_manager install_bundle target="git+https://gitee.com/wumingys/gdcj.git"
```

> 从 git 装会连依赖一起从 registry 拉（`@deepseek-ai/schemastery` 等），
> 所以**要联网**；想离线装，用下面的 tarball 或本地目录。

### 方式二：从本地目录安装（最简单，适合给同机 / 同网同事）

1. 把整个 `gongsi-tickets-panel` 目录拷到对方机器上，记下绝对路径。
2. 在 DSH 里让 Agent 执行：

   ```
   plugin_manager install_bundle target="link:<绝对路径>"
   ```

   例如 `link:C:\plugins\gongsi-tickets-panel`。

   该命令会把包写进当前 profile 的 `dependencies`、建好软链，并在 `dsh.profile.bundles` 里登记。

3. 重启 DSH（或让 Agent 重新加载），左侧栏出现「工单」图标。

> 目录里的 `node_modules` **建议一起拷**：拷过去就等于把依赖带在身边，插件靠它自己那份解析，**完全离线可用**。
> 不想拷也行，在该目录跑一次 `npm install`（`@deepseek-ai/schemastery` 在公共 npm 上有）。

### 方式三：从 tarball 安装（离线友好）

仓库里已经带了一份打好的包 `packages/local-gongsi-tickets-panel-1.0.9.tgz`，下载后：

```
plugin_manager install_bundle target="<tgz 的绝对路径>"
```

> tarball 里**只有插件自己的文件**（不含 `node_modules`），依赖由 pnpm 按 `package.json` 解析。
> 本机 store 里已经有这三个依赖版本时，装完不联网也能跑；实在要离线，**用方式二**（拷目录）。

自己重新打：

```bash
pnpm pack --pack-destination packages   # 产出 local-gongsi-tickets-panel-1.0.9.tgz
```

### 方式四：发布到 npm 后按包名安装

`@local` 这个 scope 不能发布。要先改成你能发布的包名，例如 `gongsi-tickets-panel` 或 `@your-name/gongsi-tickets-panel`：

1. 改 `package.json` 的 `name`。
2. 同步改 `cordis.patch.yml` 里的 `name` 字段（两处必须一致）。
3. `npm publish`。
4. 对方：`plugin_manager install_bundle target="gongsi-tickets-panel@1.0.7"`。

## 首次使用：填 API Key

插件**不携带任何密钥**。安装后打开面板 → 「配置」标签页，填写：

| 字段 | 说明 |
|---|---|
| 接口地址 | 默认 `https://yanfa.scedu.tech/api/mcp`，一般不用改 |
| API Key | **必填**，对方自己的 gongsi 密钥 |
| 每页显示条数 | 1–40，默认 15 |
| 请求超时 | 默认 20000 ms |

三个字段都是「可实时编辑」的（volatile），改完立即生效，不需要重启。

**用户身份不用配**：插件用 `task_list_my_tasks` 里 `is_owner=1` 的行自动识别当前 Key 对应的人；换 Key 会自动重新识别。

## 目录结构

```
gdcj/                        ← 仓库根目录就是插件包（git URL 安装装的就是它）
├── index.js            # Host 半：MCP 客户端、命令、Agent 工具、Config、技能注册
├── client.js           # Client 半：侧边栏面板、标签页、筛选、分页、表单、图片查看器
├── cordis.patch.yml    # 把插件行插入 profile 的 bundle patch
├── package.json        # 包元数据 + dsh.bundle / dsh.client 声明
├── locale/{zh,en}.json # 插件元信息（标题 / 描述）
├── icon.svg            # 侧边栏图标
├── packages/           # 打好的安装包（离线安装用）
├── test/               # 本地自检脚本（不随包发布）
│   ├── panel-layout.test.mjs    # 面板布局契约：头部/标签/筛选固定，列表滚动
│   ├── assign-picker.test.mjs   # 分派控件契约：一个框既能搜又能选，列表自动向上展开
│   ├── complete-root-cause.test.mjs # 关单三步契约：原因分析单独保存、确认完成不填内容、有原因分析才出现
│   ├── root-cause.test.mjs      # 关单落点契约：原因分析写成根因日志、读回来当结论
│   ├── install-matrix.test.mjs  # 安装矩阵契约：包里不带 node_modules，各种装法都不撞车
│   ├── regress-check.mjs        # 反向验证：把布局改坏后测试必须失败
│   └── regress-assign-check.mjs # 反向验证：把分派控件改坏后测试必须失败
└── skills/
    └── gongsi-ticket-kb/   # 整包内置的知识库技能（SKILL.md + references/ + scripts/）
```

## 本地自检

```bash
npm test                            # 四个自检脚本一起跑
node test/panel-layout.test.mjs     # 面板布局契约
node test/assign-picker.test.mjs    # 分派控件契约
node test/complete-root-cause.test.mjs  # 关单三步契约：原因分析单独保存、确认完成不填内容、有原因分析才出现
node test/root-cause.test.mjs       # 关单落点契约：原因分析写成根因日志、读回来当结论
node test/install-matrix.test.mjs   # 安装矩阵契约（要真跑 pnpm，慢一点）
node test/regress-check.mjs         # 反向验证：布局改坏后测试必须报错
node test/regress-assign-check.mjs  # 反向验证：分派控件改坏后测试必须报错
```

`panel-layout.test.mjs` 不依赖浏览器：它按浏览器的方式加载 `client.js`
（`window.__ModuleLoader__.load`），用一个只保留 hook 顺序的 React 替身渲染面板，
再对渲染出来的元素树断言 —— 面板本身不滚动，头部 / 标签 / 筛选留在固定块里，
工单列表在滚动块里，详情页的「返回」按钮同样留在滚动块之外；
另外断言「分享」按钮带的是正确的管理台深链，点了会把链接写进剪贴板、也不会误开详情。

`assign-picker.test.mjs` 用一个**真的会保存状态**的 React 替身驱动「分派」控件：
断言表单里只有这一个框（输入即搜、选中即定）、框贴近下缘时下拉列表向上展开、
以及人员目录只在停手后问一次（打字过程中不重复请求，换字时旧请求作废）。

`install-matrix.test.mjs` 拿真包跑真安装：先把包复制到临时目录、**装上依赖**再 `pnpm pack`，
然后断言 tarball 里**没有 `node_modules`**、`package.json` 里**没有 `bundleDependencies`**，
再用 pnpm 依次装进「全新 / 覆盖 / 先目录后 tarball / 离线」几种场景，
每一种都不能出现 `ERR_PNPM_LINKING_FAILED`。把 `bundleDependencies` 加回去，这条自检会红。

`complete-root-cause.test.mjs` 与 `root-cause.test.mjs` 一起盯住关单这条线：
前者（Client 半）断言行里是**两步**——「原因分析」一个框、单独保存；「确认完成」**没有输入框**，
而且**只有原因分析存好之后才出现**；服务端回「还没有原因分析」时，用户会被送回原因分析那一步。
后者（Host 半，用假 MCP 客户端）断言原因分析写成一条 `root_cause` 日志、
关单时**把已记录的原因分析读回来当结论**、读不到就不关单，
服务端不认这个日志类型时退回写成处理说明（内容不丢）。

## 版本

**版本号只增不改**：改了代码就把 `package.json` 的 `version` 往上抬一位，再 `npm pack`。
文件名自带版本（`local-gongsi-tickets-panel-<版本>.tgz`），旧包留在 `gongsi-tickets-panel-dist/` 里**不会被覆盖**，
发出去时不会和上一版混淆。

| 版本 | 改动 |
|---|---|
| **1.0.9** | 关单那两步改成**互斥**：没填原因分析时行里只有 `原因分析`；存好之后 `原因分析` **收起**，只剩 `确认完成`。两者不会再同时出现。 |
| **1.0.8** | 关单拆成**三步**：**开始处理** → **原因分析** → **确认完成**。原因分析是一个独立的框，存成一条 `root_cause` 任务日志；**确认完成不带输入框**，而且**只有原因分析存好之后才出现**（服务端不给原因分析就不让关单）。关单时把已记录的原因分析读回来当处理结论。 |
| **1.0.7** | 「确认完成」多一个**原因分析**：单独记一条 `root_cause` 类型的任务日志（写在关单之前，写不进去就不关单），和处理结论分开留痕。Agent 侧 `gongsi_ticket_action` 同步多一个 `rootCause` 参数。 |
| **1.0.6** | 打包方式改成「依赖由 pnpm 解析」：tarball 里不再带 `node_modules`，修掉覆盖安装时 pnpm 报 `ERR_PNPM_LINKING_FAILED` 的问题。附安装矩阵自检 `test/install-matrix.test.mjs`。 |
| **1.0.5** | 没有处理人的工单加**红色**「未分派」标签（列表行 + 详情页头部），跟「待确认」这类状态标签并排。 |
| **1.0.4** | 「分派」的标题、输入框、按钮排在**同一行**（标题不再单独占一行）。 |
| 1.0.3 | 「分派」并成**一个框**：输入姓名即搜、选中即定处理人；下拉列表贴近面板下缘时自动向上展开；人员目录改为停手后再问，打字过程中不重复请求。附控件契约自检 `test/assign-picker.test.mjs`。 |
| 1.0.2 | 工单行右侧加「分享」：点一下把该工单在管理台的链接复制到剪贴板（详情页头部也有）。 |
| 1.0.1 | 面板布局：标题栏、标签页、筛选条固定在顶部，只有工单列表滚动；详情页的「返回」按钮同样固定在滚动区之外。附布局契约自检 `test/panel-layout.test.mjs`。 |
| 1.0.0 | 首个版本：工单列表、筛选、分页、评论 / 记工时 / 分派 / 开始处理 / 确认完成、详情、引用、新建工单、配置页。 |

## 卸载

```
plugin_manager remove_bundle target="@local/gongsi-tickets-panel"
```

或 `plugin_manager set_bundle target="@local/gongsi-tickets-panel" enabled=false` 仅禁用。

## 注意事项

- **密钥安全**：分享时只发目录 / tarball / 包，**不要**把 `~/.dsh/profiles/<profile>/cordis.patch.yml` 发出去 —— 那里面存的是明文 Key。
- **git 安装要机器上有 git**：从 `git+ssh://git@gitee.com/wumingys/gdcj.git` 装，DSH 会调 `git` 拉仓库 —— 机器上没装 git 就装不了（私有仓库还要配 SSH 公钥）。**没这些条件就用 tarball**：一个文件，不需要 git、不需要 SSH，装完就能用。
- **依赖不再随包走**（1.0.6 起）：`@deepseek-ai/schemastery` 等由 pnpm 按 `package.json` 解析，版本和 DSH 自带插件一致，
  本机多半已经就有。**要完全离线**，用方式二：把插件目录整个拷过去（**连 `node_modules` 一起**），再 `link:` 装。
- **别用 1.0.5 及更早的 tarball 覆盖安装**：那些包内置了 `node_modules`，覆盖时会撞上 pnpm 的
  `ERR_PNPM_LINKING_FAILED`。已经装过的先 `plugin_manager remove_bundle target="@local/gongsi-tickets-panel"`，再装 1.0.7。
- **接口地址**：默认指向公司内网地址，外网/其他环境需要对方自己改「配置」里的地址。
- **权限**：面板能看到的工单由对方的 gongsi 账号决定；「我的工单」只显示对方自己负责的。
- **归档会话**：当前会话被归档后，面板会自动回退到最新的可用会话继续刷新；所有会话都归档时，会提示新建或切换会话（工单查询要借用某个会话的 Agent）。
- **冷启动**：插件用 `export const inject = ['commands', 'tools', 'skills']` 声明依赖，由框架**等这三个服务就绪后再挂载**。所以装好后**重启 DSH 也能正常用** —— 命令一定会注册，不会出现「Host 半没有加载，命令未注册」。

## License

MIT
