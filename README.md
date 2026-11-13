# dsh-session-index

> DSH（DeepSeek Harness）+ WorkBuddy 的**全会话索引与跨会话记忆** MCP 插件。
> 拉取仓库 → 双击安装 → 之后全自动。零第三方依赖，源会话文件全程只读。

| 项目 | 值 |
|---|---|
| 版本 | **v2.3.0** |
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

## 安装：从仓库拉取（推荐）

```bash
git clone git@github.com:Lau-Jin/DSH.git
cd DSH
```

然后：

- **Windows**：双击 `install.cmd`
- **macOS / Linux / Git Bash**：`./install.sh`

装完即可用。若 DSH 正在运行且工具列表没刷新，**完全退出 DSH 桌面端再打开**一次（最小化无效）。
之后新会话由文件事件自动识别，**不需要再重启 DSH**。

### 前置条件

1. **Node ≥ 22.15** —— `node -v` 确认。低于此版本没有 `zlib.zstdDecompressSync`，无法解压会话文件。
2. **Git + GitHub SSH key** —— 私有仓库，`ssh -T git@github.com` 应返回 `Hi <账号>! You've successfully authenticated`。

### 安装脚本做了什么

`install.cmd` / `install.sh` 只是包装，实际调用 `node install.mjs`：

1. 解析可用的 Node（含 zstd 支持校验）
2. **备份**并写入 `~/.dsh/profiles/desktop/cordis.patch.yml` 中带标记的 MCP 配置块
3. 安装 Skill 到 `~/.dsh/skills/session-index/SKILL.md`
4. 自动生成插件包与技能包到 `dist/`
5. 打印 6 项校验结果

幂等：重复运行不会产生重复条目；**更新后重跑会保留你手工改过的 env 值**（除非显式加 `--reset-env`）。

### 手动方式（可选）

不想用脚本，也可以在 DSH「MCP 与技能」→ MCP 里添加 stdio server：

| 字段 | 值 |
|---|---|
| 名称 | `session-index` |
| command | `node` 的绝对路径 |
| args | `<仓库目录>/server.mjs` |

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
| `dist/dsh-session-index-v2.3.0.zip` | 全部源码 + 清单 + 文档 + 手册 + 脚本 + `MANIFEST.json` + `INSTALL.md` | 完整分发，解压后双击 `install.cmd` |
| `dist/session-index-skill-v2.3.0.zip` | 根 `SKILL.md` + 说明 | 直接导入 DSH「MCP 与技能」 |

包内**排除**：索引分片 `*.jsonl.gz`、`meta/cards/notes/vectors.json`、备份与临时文件、已有 zip。
已验证包内无任何会话数据与密钥，可安全分发。也可随时 `node pack.mjs` 重打，或调 MCP 工具 `session_index_package`。

---

## 配置项

全部通过 MCP 配置块的 `env` 设置（`~/.dsh/profiles/desktop/cordis.patch.yml`）：

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
├── build-index.mjs                 # 索引构建（多帧 zstd → 可检索记录 + 会话卡）
├── install.mjs                     # 安装 / 校验 / 卸载 / 自动打包
├── pack.mjs                        # 打包 CLI（零依赖 ZIP writer）
├── smoke.mjs                       # 66 项端到端自测
├── install.cmd / install.sh        # 一键安装（双击 / 执行）
├── update.cmd / update.sh          # 更新（git pull + 重装）
├── plugin.json                     # 机器可读能力清单（也通过 MCP 资源暴露）
├── package.json                    # 元信息 + dsh.plugin 声明
├── 操作使用手册.html                # 自包含单页手册（14 章）
├── lib/
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

```bash
node install.mjs --uninstall
```

移除配置块与自动安装的 Skill（先备份）。索引目录 `~/.dsh/session-index/` 可保留（不影响原始会话），也可手动删除。

---

## 许可

MIT
