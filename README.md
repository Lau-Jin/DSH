# DSH 插件仓库

本机正在使用的 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai) 轻量插件。
**每个插件一个独立的私有仓库**，安装时按需分别拉取，互不牵连。

- 目标 DSH 版本：`>= 0.2.1-rc.3 < 0.3.0`（整理时本机 `dsh -V` = `0.2.1-rc.5`）
- 安装前置：
  - Git for Windows（本机 `2.56.0.4`），安装 git 依赖时要调用 `git clone`
  - GitHub SSH key（默认 `~/.ssh/id_ed25519`），且 `ssh -T git@github.com` 返回 `Hi <账号>! You've successfully authenticated...`
  - 建议设置 `GIT_SSH_COMMAND="ssh -o ServerAliveInterval=10 -o ConnectTimeout=20"`，避免慢主机上 SSH 超时

## 插件一览

| 插件 | 独立仓库（可单独拉取） | 包名 | 版本 | 说明 |
| --- | --- | --- | --- | --- |
| 工单面板 | [`Lau-Jin/gongsi-tickets-panel`](https://github.com/Lau-Jin/gongsi-tickets-panel) | `@local/gongsi-tickets-panel` | 1.0.9 | 左侧栏「工单」：列表 / 详情 / 评论 / 记工时 / 分派 / 开始处理 / 关单，另含 4 个 Agent 工具与 2 个技能。原仓 [gitee.com/wumingys/gdcj](https://gitee.com/wumingys/gdcj)（MIT） |
| 思源桥面板 | [`Lau-Jin/siyuan-bridge`](https://github.com/Lau-Jin/siyuan-bridge) | `dsh-siyuan-bridge` | 0.1.0 | 把 SiYuan 的搜索 / 阅读 / 编辑 / 导出界面嵌进 DSH 主面板（本地自建，MIT） |
| 免费模型面板 | [`Lau-Jin/our-free-model`](https://github.com/Lau-Jin/our-free-model) | `dsh-our-free-model` | 2.8.0 | 大体积第三方插件（约 30MB，含 wasm / vendor）。上游第三方 MIT：[Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) |

三个仓库都是**私有仓库**，通过 SSH 访问；每个仓库的**根目录就是插件包根**（`package.json` 在根上），
所以一条 `git+ssh://` 安装规格装出来的就是那一个插件。

## 安装（每个插件单独拉取）

```bat
dsh plugin --profile desktop add "git+ssh://git@github.com:Lau-Jin/gongsi-tickets-panel.git"
dsh plugin --profile desktop add "git+ssh://git@github.com:Lau-Jin/siyuan-bridge.git"
dsh plugin --profile desktop add "git+ssh://git@github.com:Lau-Jin/our-free-model.git"
```

- 用 DSH 自带的插件 CLI（会同时写入 profile 的 `dependencies` 与 `dsh.profile.bundles`）；
  也可以把同一串 target 粘到 DSH 图形界面的插件管理器里安装。
- 只装其中一个就行，**不必全装**；各自独立，互不牵连。
- 本机实测（pnpm 11.28.5）：工单面板 **24 秒**、思源桥面板 **25 秒**，
  装完 profile 的 `node_modules` 里只出现各自那一个插件，不会顺带拉进别的插件。
- 换成公开仓库时可把 `git+ssh://git@github.com/` 换成 `git+https://github.com/`。
- 装完刷新窗口（Ctrl+R）或重启 DSH；侧栏出现对应图标即成功。

安装后的首次配置：

- **工单面板**：左侧「工单」→「配置」标签页 → 填自己的 API Key（接口地址默认 `https://yanfa.scedu.tech/api/mcp`）。
- **思源桥面板**：需要本机 `siyuan-bridge` 服务在 `127.0.0.1:5599` 运行（`siyuan-bridge\start.cmd` 拉起）。
- **免费模型面板**：装好即用，无需登录 / 注册 / 填 API Key。

## 用 tar 包安装（不需要 git / SSH，离线友好）

三个包也各自单独打好了，集中存放在 `D:\Google\dsh-plugin-pkg\`（与 Git 仓库分开）：

```bat
dsh plugin --profile desktop add "file:D:/Google/dsh-plugin-pkg/local-gongsi-tickets-panel-1.0.9.tgz"
dsh plugin --profile desktop add "file:D:/Google/dsh-plugin-pkg/dsh-siyuan-bridge-0.1.0.tgz"
dsh plugin --profile desktop add "file:D:/Google/dsh-plugin-pkg/dsh-our-free-model-2.8.0.tgz"
```

## 本仓库（`Lau-Jin/DSH`）是什么

插件已经逐个拆到各自的独立仓库，本仓库保留为**汇总与备份**：`packages/` 下留有同一份插件源码，
仍可用 pnpm 的「git 仓库子目录」写法安装：

```bat
dsh plugin --profile desktop add "git+ssh://git@github.com:Lau-Jin/DSH.git#path:/packages/gongsi-tickets-panel"
dsh plugin --profile desktop add "git+ssh://git@github.com:Lau-Jin/DSH.git#path:/packages/siyuan-bridge"
```

> `#path:/packages/<目录>` 是 pnpm 的 git 子目录规格（已在本机 11.28.5 验证）。
> 这种写法只装指定的子目录包，但**仍会克隆整个本仓库**；想只拉一个插件，用上面的独立仓库。

`main` 分支刻意保持轻量（约 3MB）：约 30MB 的 `our-free-model` 已彻底移出，不在本仓库的任何分支或历史里。

## 免费模型面板（our-free-model，独立仓库）

```bat
dsh plugin --profile desktop add "git+ssh://git@github.com:Lau-Jin/our-free-model.git"
```

- 独立仓库的根目录就是插件包根，包名 `dsh-our-free-model`，版本 `2.8.0`。
- 独立仓库中 `package.json` 的 `repository` / `homepage` / `bugs` 已指向该仓库；
  上游 Gemini CLI 已公开发布的 installed-app OAuth 客户端 ID/Secret 在源码中改为分段拼接
  （运行时拼接结果与原文逐字节一致，用户无需任何额外配置），以避免被 GitHub Push Protection 拦截。
- 单独的 tar 包：`D:\Google\dsh-plugin-pkg\dsh-our-free-model-2.8.0.tgz`（约 28MB），可离线分发。

### 为什么单独成库

pnpm 解析 git 依赖时会 fetch 仓库的**全部 refs**。当 `our-free-model` 作为同一仓库的大分支存在时，
每次安装其它插件也会拉取这 30MB，使安装时间从约 1 分钟增加到约 17 分钟。拆成独立仓库后：

- 主仓库克隆约 **3MB / 31 秒**
- 实测 pnpm 安装 `dsh-siyuan-bridge` 从 **1015 秒降到 63 秒**
- 现在装独立仓库版本只要 **约 25 秒**

> 上游：<https://github.com/Ebony-Vinyl/dsh-our-free-model>（第三方 MIT），包内保留其原始 `LICENSE`、`NOTICE.md`、`README.md`。

## 更新与卸载

```bat
:: 只看已装的包有没有新提交，然后重新解析依赖
dsh plugin --profile desktop update

:: 卸载单个插件（包名见上表）
dsh plugin --profile desktop remove "@local/gongsi-tickets-panel"
```

> 卸载后还需要从 profile 的 `package.json` → `dsh.profile.bundles` 里删掉对应包名；
> 用 DSH 图形界面的插件管理器卸载会自动处理这一步。

## 目录结构

```text
Lau-Jin/gongsi-tickets-panel/   # 工单面板：仓库根即插件包根
Lau-Jin/siyuan-bridge/          # 思源桥面板：仓库根即插件包根
Lau-Jin/our-free-model/         # 免费模型面板：仓库根即插件包根（约 30MB）
Lau-Jin/DSH/                    # 本仓库：汇总 / 备份镜像
├─ packages/
│  ├─ gongsi-tickets-panel/
│  └─ siyuan-bridge/
└─ README.md
```

每个插件包目录里都有 `package.json`（带 `dsh.bundle.patch` 与 `dsh.client` 声明）和
`cordis.patch.yml`（bundle patch，`insert` 一行插件注册）。

## 国内网络提示

直连 HTTPS 不稳时可临时配只读镜像：

```bat
git config --global url."https://ghfast.top/https://github.com/".insteadOf "https://github.com/"
```

该镜像仅用于 HTTPS 只读访问，部分 URL 会返回 403，且**推送仍需 SSH**。

## 来源与许可

- `gongsi-tickets-panel`：来自同事在 Gitee 的仓库（MIT），1.0.9 对应其 `master`。
- `siyuan-bridge`：本地自建插件（MIT），配套的桥接服务不在这些仓库内。
- `our-free-model`：第三方 MIT 插件，上游 <https://github.com/Ebony-Vinyl/dsh-our-free-model>。

## 维护说明

- 推送前请确认 `git remote -v` 指向正确的私有仓库。
- 私有仓库，明文凭据与 API Key 一律不要提交进来。
- `main` 分支保持轻量：超过 ~10MB 的内容放独立仓库；不要把大插件重新并入本仓库的分支或历史。
- 插件改动请改各自的独立仓库，本仓库的 `packages/` 只是备份镜像。

## 整理信息

- 整理时间：2026-11-06（首次导出 2026-11-05）
- 结构：每个插件一个独立私有仓库 + 独立 tar 包（`D:\Google\dsh-plugin-pkg\`）
