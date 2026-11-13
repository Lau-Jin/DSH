# dsh-session-index

> DSH（DeepSeek Harness）+ WorkBuddy 的**全会话索引与跨会话记忆** MCP 插件。
> 拉取仓库 → 双击安装 → 之后全自动。零第三方依赖，源会话文件全程只读。

| 项目 | 值 |
|---|---|
| 版本 | **v2.4.1** |
| 运行要求 | Node **≥ 22.15**（需要 `zlib.zstdDecompressSync`） |
| MCP 能力 | **13 个工具** / 4 个提示词 / 8 个资源 |
| 第三方依赖 | **0**（只用 Node 标准库） |
| 完整手册 | [`操作使用手册.html`](./操作使用手册.html)（单页 14 章，导航 / 搜索 / 一键复制） |

---

## 它解决什么问题

DSH 的会话存在 `~/.dsh/sessions/` 下，是**上千个独立 zstd 帧拼接**的 `session.v4.jsonl.zstd`，单文件可达 20 MB。
想在新会话里回顾旧结论，只能整包解压翻全文——慢，而且极耗 token。

本插件把全部会话**预先索引成结构化记忆单元**（会话卡：提问、结论、涉及路径、工具、关键词、血缘），
之后一次工具调用就能拿到结论速览，用关键词只取命中片段，**不必再把几十 MB 历史灌进上下文**。

---

## 安装

### 方式 A：DSH 插件页（推荐 · 零命令行）

1. 打开 DSH → **插件页**
2. 粘贴仓库地址：`https://github.com/Lau-Jin/DSH`
3. 点安装，按提示**完全退出 DSH 再打开**（最小化无效）

装完就是可用状态，不用改配置、不用跑脚本、不用管 Node 路径。

> 地址带不带 `.git` 都能装：不带时 pnpm 直接走 codeload 下 tarball，**不依赖本机 git**；
> 带上 `.git` 会先做一次 `git ls-remote` 解析版本。网络抖动时前者更稳。
> 实测这两条路都能装成（本机约 80–100 秒，主要是 GitHub 往返延迟，包本身只有 83 KB）。

**它为什么能自己找到入口**——插件包里的 `cordis.patch.yml` 会随 bundle 自动应用，挂两行：

| 行 id | 包 | 作用 |
|---|---|---|
| `session-index-host` | `dsh-session-index` | 宿主半身（`lib/index.mjs`）：用 `import.meta.url` 解析**真实安装目录**，把 `server.mjs` 绝对路径写进 `~/.dsh/session-index/server-path.txt` |
| `mcp-session-index` | `@deepseek-ai/dsh-mcp-client` | MCP stdio 客户端：13 工具 / 4 提示词 / 8 资源 |

那行配置里的 `command`、`args`、`DSH_HOME` 三处都是 `!!js` 表达式，**在 DSH 加载配置时求值**（不是安装时），
按「显式环境变量 → 宿主记下的路径文件 → profile 标准安装位置」依次探测。
所以仓库放哪、pnpm 装到哪、换了 Node 版本，都不需要改文件。

宿主行排在前、MCP 行排在后，路径文件先落盘，MCP 侧首次 spawn 就能命中——**一次重启即生效**。

### 方式 B：clone + 一键脚本（想自己控制目录 / 离线分发）

```bash
git clone https://github.com/Lau-Jin/DSH.git
cd DSH
```

然后：

- **Windows**：双击 `install.cmd`
- **macOS / Linux / Git Bash**：`./install.sh`

`install.mjs` 会先判断 profile 是否已经以 bundle 方式注册了本插件：

- **已注册**（你从插件页装过）→ 不再写 profile 配置，只把残留的旧配置块清掉，避免出现两条同 id 的 MCP 行；
- **未注册**（纯 clone 用户）→ 往 `~/.dsh/profiles/desktop/cordis.patch.yml` 写一个带标记的配置块。

两种情况都会：写好 `server-path.txt`、装 Skill、生成可分发包。

### 方式 C：手动加 MCP（不推荐，仅排障用）

DSH「MCP 与技能」→ MCP 里添加 stdio server：

| 字段 | 值 |
|---|---|
| 名称 | `session-index` |
| command | `node` 的绝对路径（需 ≥ 22.15） |
| args | `<仓库目录>/server.mjs` |

### 前置条件

1. **Node ≥ 22.15** —— 需要 `zlib.zstdDecompressSync`。插件页安装时会自动挑 DSH 自带的 Node（`~/.dsh/dsh-runtimes/*/dependencies/node`），通常不用你操心。
2. 方式 B 需要 **Git**；仓库已转公开，无需 SSH key。

### 安装脚本做了什么

`install.cmd` / `install.sh` 只是包装，实际调用 `node install.mjs`：

1. 解析可用的 Node（含 zstd 支持校验）
2. 判断安装方式（bundle / patch），必要时**备份**并写入 `cordis.patch.yml` 的标记块
3. 写 `~/.dsh/session-index/server-path.txt`，记下 MCP 入口绝对路径
4. 安装 Skill 到 `~/.dsh/skills/session-index/SKILL.md`
5. 自动生成插件包与技能包到 `dist/`
6. 打印 6 项校验结果

幂等：重复运行不会产生重复条目；**更新后重跑会保留你手工改过的 env 值**（除非显式加 `--reset-env`）。

---

## 插件页装不上？先跑环境体检

DSH 插件页装任何东西，底层都是一次 `pnpm install`。装不上时提示常常被归类成
「没有写入权限，无法安装」，但**真实原因通常在 pnpm 那一步**。装上本插件后可以直接体检：

```bash
node install.mjs --doctor
```

七项检查，每项给出结论与修法（只读，不改任何文件）：

| 检查 | 会导致的现象 |
|---|---|
| Node 支持 zstd | 索引建不起来 |
| git 全局 URL 重写 | 走第三方镜像时 codeload 返回 403 / 认证失败 |
| pnpm `fetch-timeout` | 超过 60000 会让 pnpm 11 直接抛 `UND_ERR_INVALID_ARG`，**所有安装失败** |
| 远端 git 依赖 | 每次安装都要重下，大仓库必然超时 |
| lockfile 残留 `git+ssh` | 仓库已删或缺 SSH key 时必失败 |
| bundle 是否注册 | 插件没被 DSH 加载 |
| 索引状态 | 装完但没建索引 |

### 三个已确认的坑

1. **`fetch-timeout` 有硬上限。** pnpm 11.28 + undici 在 `fetch-timeout > 60000` 时直接报
   `UND_ERR_INVALID_ARG`（实测 60000 正常、65000 就失败）。调大超时不仅没用，还会让所有安装全挂。
2. **大 tarball 装不完。** GitHub 直连在本机约 70–350 KB/s，28 MB 的包需要数分钟，
   永远超不过 60 秒上限，于是 `UND_ERR_DESTROYED` 反复重试直到失败。
   正解不是调超时，而是**把这类依赖本地化**：复制到本地目录，依赖写成 `link:`，
   之后安装完全离线（实测整份 profile 8 秒装完）。
3. **`insteadOf` 镜像规则会连坐。** `url.https://<镜像>/https://github.com/.insteadOf`
   会重写所有 GitHub HTTPS 地址，而镜像一般不代理 `codeload.github.com`（返回 403）。
   直连可用时建议去掉：
   ```bash
   git config --global --get-regexp "url\..*\.insteadof"     # 先看有没有
   git config --global --unset-all "url.https://<镜像前缀>.insteadOf"
   ```

> 本次修复的完整做法（复制包 → `link:` → 离线重建 lockfile）见
> `操作使用手册.html` 第 13 章「排障」。

---

## 装上之后是自动的

| 行为 | 说明 |
|---|---|
| 首次建索引 | server 启动时后台子进程构建，**不阻塞 MCP 握手**；未就绪时工具会提示稍候 |
| 新会话识别 | `fs.watch` 递归监听 DSH 与 WorkBuddy 会话目录，写入停止约 3.5 秒后增量纳入 |
| 定时兜底 | 每 60 秒增量刷新，只处理 size/mtime 变化的文件 |
| 安静期保护 | 已有索引的活跃会话需静止 45 秒才重建，避免反复解压正在写入的大文件 |
| 客户端通知 | 索引更新后发 `notifications/resources/list_changed`，客户端无需重启即可感知 |
| 自愈 | 索引缺失或损坏时，下次启动自动重建 |

本机实测（31 个会话）：全量构建 **约 10 秒**、索引 **约 12 MB**（源文件 55 MB+）；
增量刷新 **约 0.85 秒**，无变化时 **约 30 ms**；新会话从写入到可检索 **约 70 ms**。

---

## 工具速览

推荐调用链：`status → brief → related/thread → search → get`，逐级放大，避免一上来灌全文。

| 工具 | 用途 |
|---|---|
| `session_index_status` | 索引与自动维护状态（含监听、下次刷新倒计时） |
| `session_index_brief` | 跨会话结论速览；带 `query` 只取相关主题 |
| `session_index_list` | 会话清单（标题 / 时间 / 工作区 / 应用） |
| `session_index_related` | 相关会话 + 关联理由（共享路径 / 关键词 / 工具 / 血缘 / 同工作区） |
| `session_index_thread` | 父子血缘链（compact 上游、subagent 下游、同源兄弟） |
| `session_index_search` | 语义检索，**只返回命中片段**；默认排除系统注入噪声 |
| `session_index_get` | 先看会话骨架，再按 `seq` 精确取原文 |
| `session_index_remember` | 写入长期记忆（类型 / 标签 / 重要度） |
| `session_index_recall` | 召回长期记忆（时间衰减排序） |
| `session_index_forget` | 归档或删除记忆（默认归档） |
| `session_index_refresh` | 手动增量刷新 |
| `session_index_package` | 重新生成分发包 |
| `session_index_vectors` | 可选的向量索引管理 |

另提供提示词 `session-context` / `resume-topic` / `catch-up` / `quickstart`，
资源 `session-index://guide`、`://plugin.json`、`://status`、`://brief`、`://memory` 等。
`initialize` 会返回 `instructions`，客户端不读外部文档也能正确上手。

**搜索模式**：`semantic`（默认，本地同义词扩展 + BM25，零 token）、`keyword`（精确 AND）、
`hybrid` / `vector`（需配置 embedding，未配置自动降级为本地语义检索）。

---

## 更新 / 校验 / 回滚

```bash
# Windows
update.cmd              # git pull + 重装（保留 env 自定义）

# macOS / Linux
./update.sh
```

```bash
node install.mjs --doctor        # 环境体检（7 项，装不上时先跑这个）
node install.mjs --verify        # 6 项状态校验
node install.mjs --dry-run       # 预览改动，不写文件
node install.mjs --uninstall     # 移除配置块与自动装的 Skill（先备份）
node install.mjs --reset-env     # 用默认值覆盖 env 自定义
node smoke.mjs                   # 66 项端到端自测
```

---

## 分发包（离线 / 无 git 环境）

`install.mjs` 每次运行会自动生成：

| 文件 | 内容 | 用途 |
|---|---|---|
| `dist/dsh-session-index-v2.4.1.zip` | 全部源码 + 清单 + 文档 + 手册 + 脚本 + `MANIFEST.json` + `INSTALL.md` | 完整分发，解压后双击 `install.cmd` |
| `dist/session-index-skill-v2.4.1.zip` | 根 `SKILL.md` + 说明 | 直接导入 DSH「MCP 与技能」 |

包内**排除**：索引分片 `*.jsonl.gz`、`meta/cards/notes/vectors.json`、备份与临时文件、已有 zip。
已验证包内无任何会话数据与密钥，可安全分发。也可随时 `node pack.mjs` 重打，或调 MCP 工具 `session_index_package`。

---

## 配置项

全部通过配置块的 `env` 设置。改哪里取决于安装方式：

- **插件页安装**：改插件包内的 `cordis.patch.yml`（`<profile>/node_modules/dsh-session-index/cordis.patch.yml`），改完重启 DSH；
- **clone + 脚本**：改 `~/.dsh/profiles/desktop/cordis.patch.yml` 里 `>>> session-index` 标记块内的 `env`，重跑 `node install.mjs` 会保留你写的值。

| 变量 | 默认 | 说明 |
|---|---|---|
| `SESSION_INDEX_AUTO` | `1` | 总开关，`0` 关闭后台自动维护 |
| `SESSION_INDEX_AUTO_INTERVAL_MS` | `60000` | 定时增量刷新间隔（最小 15000） |
| `SESSION_INDEX_AUTO_QUIET_MS` | `45000` | 已有会话的静止期（活跃时不重建） |
| `SESSION_INDEX_WATCH` | `1` | 文件事件监听开关 |
| `SESSION_INDEX_WATCH_DEBOUNCE_MS` | `3500` | 写入事件防抖 |
| `SESSION_INDEX_WATCH_QUIET_MS` | `6000` | 监听路径的静止期 |
| `SESSION_INDEX_APPS` | `all` | 只索引 `dsh` 或 `workbuddy` |
| `SESSION_INDEX_DIR` | `~/.dsh/session-index` | 索引产物目录 |
| `SESSION_INDEX_EMBED_URL` / `_MODEL` / `_KEY` | 空 | 可选，OpenAI 兼容 embedding；不配则纯本地 |

> 改完这些值后**不要加 `--reset-env`**；正常重跑安装会保留它们。

---

## 目录结构

```text
dsh-session-index/                  # 仓库根 = 插件根
├── server.mjs                      # MCP stdio server（13 工具 / prompts / resources）
├── cordis.patch.yml                # bundle patch：挂宿主行 + MCP 行（含 !!js 自解析路径）
├── build-index.mjs                 # 索引构建（多帧 zstd → 可检索记录 + 会话卡）
├── install.mjs                     # 安装 / 校验 / 卸载 / 自动打包
├── pack.mjs                        # 打包 CLI（零依赖 ZIP writer）
├── smoke.mjs                       # 66 项端到端自测
├── install.cmd / install.sh        # 一键安装（双击 / 执行）
├── update.cmd / update.sh          # 更新（git pull + 重装）
├── plugin.json                     # 机器可读能力清单（也通过 MCP 资源暴露）
├── package.json                    # 元信息 + dsh.bundle.patch + dsh.plugin 声明
├── 操作使用手册.html                # 自包含单页手册（14 章）
├── lib/
│   ├── index.mjs                   # 宿主半身：解析自身安装路径（ESM，供 bundle 挂载）
│   ├── reader.mjs                  # 多帧 zstd 读取
│   ├── extract.mjs                 # 事件 → 文本记录（含系统注入降噪）
│   ├── cards.mjs                   # 会话卡 / 关联度 / 血缘
│   ├── index-store.mjs             # 分片存储与增量签名
│   ├── source-workbuddy.mjs        # WorkBuddy 会话适配器
│   ├── semantic.mjs                # 同义词扩展 + BM25
│   ├── embedding.mjs               # 可选向量检索
│   ├── notes.mjs                   # 长期记忆库
│   ├── auto.mjs                    # 自动建索引 / 定时刷新
│   ├── watch.mjs                   # 文件事件监听
│   └── pack.mjs                    # ZIP writer
├── skill/SKILL.md                  # 自动接入用技能
└── dist/                           # 自动生成的分发包（git 忽略）
```

索引产物写入 `~/.dsh/session-index/`，**与仓库目录分离**，所以换 clone 位置不会丢索引。

---

## 隐私与安全

- **源会话只读**：任何操作都不修改 `~/.dsh/sessions/` 与 `~/.workbuddy/projects/` 下的原始文件。
- **配置写前备份**：每次改 `cordis.patch.yml` 都先复制为 `.bak-<时间戳>`。
- **不入库**：索引、长期记忆、备份、验证产物均在 `.gitignore` 中排除。
- **索引含会话原文**：`~/.dsh/session-index/` 是会话全文的本地副本，**不要打包外传**；分发请用 `dist/` 里的 zip（已自动排除）。

---

## 卸载

- **插件页安装的**：插件页里禁用或卸载 `dsh-session-index`，重启 DSH 即可（MCP 行随 bundle 一起消失）。
- **clone + 脚本安装的**：`node install.mjs --uninstall`，移除配置块与自动安装的 Skill（先备份）。

两种情况下索引目录 `~/.dsh/session-index/` 都保留（不影响原始会话），需要时手动删除。

---

## 变更记录

| 版本 | 变更 |
|---|---|
| **v2.4.1** | 新增 `install.mjs --doctor` **环境体检**（7 项，只读），覆盖插件页安装失败的四个真实成因：git URL 重写镜像、pnpm `fetch-timeout` 超上限、远端大 tarball、lockfile 残留 `git+ssh`。README 增加「插件页装不上」排障章节。 |
| **v2.4.0** | 支持 **DSH 插件页直接安装**：新增 `dsh.bundle.patch` 声明与 `cordis.patch.yml`（含 `!!js` 自解析表达式），新增宿主半身 `lib/index.mjs`。安装路径由运行时探测，不再依赖手工配置；`install.mjs` 自动识别 bundle 模式，避免与插件页安装重复注册。仓库转公开。 |
| v2.3.0 | 仓库收敛为单插件，仓库根即插件根；新增 `install.cmd/sh`、`update.cmd/sh`；重装保留手工改过的 env。 |
| v2.2.0 | 新增文件事件驱动的免重启识别（`fs.watch` + 静止期）、MCP 变更通知。 |
| v2.1.0 | 新增跨会话关联 / 血缘链 / 长期记忆（`remember` / `recall` / `forget`）。 |
| v2.0.0 | 从「全文检索」重构为「会话卡 + 结构化速览」。 |

---

## 许可

MIT
