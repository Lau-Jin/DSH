# DSH 插件仓库

本仓库收集本机正在使用的 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai) 轻量插件，
以后直接从本仓库安装即可，不必再依赖各自的原始来源。

- 仓库：`git@github.com:Lau-Jin/DSH.git`（**私有仓库**，需本机 SSH 公钥已加入 GitHub 账号）
- 目标 DSH 版本：`>= 0.2.1-rc.3 < 0.3.0`（导出时本机 `dsh -V` = `0.2.1-rc.5`）
- 安装前置：
  - 需要安装 Git for Windows（当前已安装 `2.56.0.4`），以便执行 `git ls-remote` / `git clone` 并安装 git 依赖
  - 需要配置 GitHub SSH key（默认使用 `~/.ssh/id_ed25519`），且 `ssh -T git@github.com` 能返回 `Hi <你的账号>! You've successfully authenticated...`
  - 建议设置 `GIT_SSH_COMMAND="ssh -o ServerAliveInterval=10 -o ConnectTimeout=20"`，避免访问慢主机时发生 SSH 超时

> 本仓库刻意保持轻量。体积较大的第三方插件 `our-free-model`（约 30MB）已经拆分到
> 独立私有仓库 [`Lau-Jin/our-free-model`](https://github.com/Lau-Jin/our-free-model)，
> 不在本仓库的 `main` 分支中。

## 插件一览

| 目录 | 包名 | 版本 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `packages/gongsi-tickets-panel` | `@local/gongsi-tickets-panel` | 1.0.9 | 工单面板：左侧栏「工单」的列表 / 详情 / 评论 / 记工时 / 分派 / 开始处理 / 关单，另含 4 个 Agent 工具与 2 个技能 | 原仓 [gitee.com/wumingys/gdcj](https://gitee.com/wumingys/gdcj)（MIT） |
| `packages/siyuan-bridge` | `dsh-siyuan-bridge` | 0.1.0 | 思源桥面板：把 SiYuan 的搜索 / 阅读 / 编辑 / 导出界面嵌进 DSH 主面板 | 本地自建（MIT） |
| 不在本仓库 | `dsh-our-free-model` | 2.8.0 | 免费模型面板：大体积第三方插件（约 30MB），仓库根目录即插件包根 | 独立仓库 [`Lau-Jin/our-free-model`](https://github.com/Lau-Jin/our-free-model)（私有，SSH 访问）；上游第三方 MIT：[Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) |

## 安装

用 DSH 自带的插件 CLI（会同时写入 profile 依赖和 `dsh.profile.bundles`）：

```bat
dsh plugin --profile desktop add "git+ssh://git@github.com/Lau-Jin/DSH.git#path:/packages/gongsi-tickets-panel"
dsh plugin --profile desktop add "git+ssh://git@github.com/Lau-Jin/DSH.git#path:/packages/siyuan-bridge"
```

- `#path:/packages/<目录>` 是 pnpm 的「git 仓库子目录」写法（已在本机 pnpm 11.28.5 上验证）。
- 仓库是私有的，所以用 `git+ssh://` 形式；如果哪天改成公开仓库，也可以换成
  `git+https://github.com/Lau-Jin/DSH.git#path:/packages/<目录>`。
- 国内直连 HTTPS 不稳时，可临时配置只读镜像：
  `git config --global url."https://ghfast.top/https://github.com/".insteadOf "https://github.com/"`；
  推送前记得取消该配置。该镜像仅用于 HTTPS 只读访问，私有仓库仍需使用 SSH。
- 也可以把同一串 target 粘贴到 DSH 图形界面的插件管理器里安装。
- 装完刷新窗口（Ctrl+R）或重启 DSH；侧栏出现对应图标即成功。

安装后的首次配置：

- **工单面板**：打开左侧「工单」→「配置」标签页 → 填自己的 API Key（接口地址默认 `https://yanfa.scedu.tech/api/mcp`）。
- **思源桥面板**：需要本机 `siyuan-bridge` 服务在 `127.0.0.1:5599` 运行（用 `siyuan-bridge\start.cmd` 拉起）。

## 免费模型面板（our-free-model，独立仓库）

第三方插件 `dsh-our-free-model` 2.8.0 约 30MB（含 wasm / vendor 资源），已从本仓库彻底拆分，
现在位于独立私有仓库 [`Lau-Jin/our-free-model`](https://github.com/Lau-Jin/our-free-model)：

```bat
dsh plugin --profile desktop add "git+ssh://git@github.com/Lau-Jin/our-free-model.git"
```

- 安装规格：`git+ssh://git@github.com/Lau-Jin/our-free-model.git`。
- 独立仓库的**根目录就是插件包根**，`package.json` 的包名为 `dsh-our-free-model`，版本为 `2.8.0`。
- 仓库是私有的，需使用已配置好的 GitHub SSH key。

### 为什么拆分仓库

pnpm 解析 git 依赖时会 fetch 仓库的**全部 refs**。当 `our-free-model` 作为同仓库的大分支存在时，
每次安装其他插件也会拉取这 30MB 分支，使安装时间从约 1 分钟增加到约 17 分钟。

拆成独立仓库后：

- 主仓库克隆约 **3MB / 31 秒**
- 实测 pnpm 安装 `dsh-siyuan-bridge` 从 **1015 秒降到 63 秒**

> 上游：<https://github.com/Ebony-Vinyl/dsh-our-free-model>（第三方 MIT），包内保留其原始 `LICENSE`、`NOTICE.md`、`README.md`。

## 更新与卸载

```bat
:: 拉取本仓库最新提交后重新解析依赖
dsh plugin --profile desktop update

:: 卸载单个插件（包名见上表）
dsh plugin --profile desktop remove "@local/gongsi-tickets-panel"
```

> 卸载后还需要从 profile 的 `package.json` → `dsh.profile.bundles` 里删掉对应包名；
> 用 DSH 图形界面的插件管理器卸载会自动处理这一步。

## 目录结构

```text
DSH/                          # main 分支：轻量插件
├─ packages/
│  ├─ gongsi-tickets-panel/   # 工单面板（根目录即插件包，含 locale / skills / test）
│  └─ siyuan-bridge/          # 思源桥面板（lib 已构建）
└─ README.md
```

- `packages/gongsi-tickets-panel/`：工单面板插件。
- `packages/siyuan-bridge/`：思源桥面板插件。
- `our-free-model` **不在本仓库**，位于独立私有仓库
  [`Lau-Jin/our-free-model`](https://github.com/Lau-Jin/our-free-model)，通过 SSH 访问。

每个 `packages/*` 目录都是一个独立的 npm 包（`package.json` 里带 `dsh.bundle.patch` 与 `dsh.client` 声明），
既可以整体安装，也可以单独安装。

## 来源与许可

- `gongsi-tickets-panel`：来自同事在 Gitee 的仓库（MIT），本仓库为镜像备份，1.0.9 对应其 `master`。
- `siyuan-bridge`：本地自建插件（MIT），配套的桥接服务不在本仓库内。
- `our-free-model`：第三方 MIT 插件，现存于独立仓库 `Lau-Jin/our-free-model`；
  上游为 <https://github.com/Ebony-Vinyl/dsh-our-free-model>，作者与上游信息见包内文件。

## 维护说明

- 推送前请确认 `git remote -v` 指向 `git@github.com:Lau-Jin/DSH.git`。
- 本仓库为私有仓库，明文凭据、API Key 一律不要提交进来。
- `main` 分支保持轻量：超过 ~10MB 的内容请放独立仓库；不要将大插件重新并入本仓库的分支或历史。

## 导出信息

- 导出时间：2026-11-05
- 导出方式：从本机 DSH profile（`desktop`）已安装 / 已加载的插件整理而来
- 说明：原本地 `@local/docsearch` 插件的源码目录已不存在（仅剩失效目录联接），故未收录
