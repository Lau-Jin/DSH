# 发布工具（三个插件共用）

这里是**跨插件共用**的发布工具链：会话索引（`dsh-session-index-lau`）、周报工作台
（`dsh-weekly-report-lau`）、思源桥（`dsh-siyuan-bridge`）走的是同一套
「仓库 → npm → 安装更新」流程，工具也共用这一份。

> 这些工具以前散落在某台机器的 `dist/publish/` 里，**不在任何 git 仓库中** ——
> 换机器或迁移工作区就会丢，而发布流程里藏着好几个「不踩就不知道」的坑
> （门禁版本标记与 smoke 写法脱节、零依赖插件过不了依赖树校验、改名污染仓名建议…）。
> 2026-11-18 起收进仓库，随代码走版本。

## 文件

| 文件 | 作用 |
|---|---|
| `插件发布标准流程.md` | **完整流程**（①→⑨）：先读这个 |
| `paths.mjs` | 路径解析：副本根目录 / 插件源目录 / DSH profile 目录 |
| `sync-publish.mjs` | ④ 同步 npm 发布副本（改名 + package.json 发布化 + 发布前校验） |
| `check-release.mjs` | ④.5 / ⑧ 发布核验门禁（`--pre` 发布前、`--post` 安装后） |
| `update-plugin.mjs` | ⑦ 安装更新助手（占位应答器绕开 Windows 目录锁） |
| `config.example.json` | 本机私有路径配置的**模板** |
| `config.local.json` | 本机私有路径配置（**不入库**，各机器自己一份） |

## 用法

```bash
cd <仓根>/tools/publish

node sync-publish.mjs session-index          # ④ 同步发布副本 + 自检
node check-release.mjs session-index --pre   # ④.5 发布前门禁（未全绿禁止发布）
node check-release.mjs session-index --post  # ⑧ 安装后核验（版本四处统一 + MCP 握手）
node update-plugin.mjs session-index         # ⑦ 安装更新助手
```

## 换机器 / 换目录怎么配

路径按 **环境变量 → `config.local.json` → 默认值** 取，三种方式任选：

```bash
# 方式一：环境变量
export PUBLISH_COPY_ROOT=/path/to/dist/publish
export DSH_PROFILE_DIR=/path/to/.dsh/profiles/desktop
export PUBLISH_SRC_SESSION_INDEX=/path/to/DSH

# 方式二：配置文件（推荐，不入库）
cp config.example.json config.local.json   # 然后改里面的路径
```

默认值：副本落在 `<仓根>/dist/publish`（已被 `.gitignore` 排除），profile 落
`~/.dsh/profiles/desktop`，插件源目录按本仓库布局推导。

## 两个容易踩的点

- **配置文件的 BOM**：Windows PowerShell 的 `Set-Content -Encoding UTF8` 会写 BOM，
  Notepad 另存为 UTF-8 也会 —— `paths.mjs` 已做容错（读配置时剥掉 BOM），
  自己写解析脚本时别忘了。
- **本机没有 `node` 在 PATH 上**：这台机器的 Node 只在 DSH 运行时目录里，
  跑 npm 相关命令前先把它加进 PATH：

  ```powershell
  $env:PATH = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;$env:PATH"
  ```
