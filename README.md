# dsh-session-index

> DSH（DeepSeek Harness）+ WorkBuddy 的**全会话索引与跨会话记忆** MCP 插件。
> DSH 插件页 / pnpm 安装 → 之后全自动。零第三方依赖，源会话文件全程只读。

| 项目 | 值 |
|---|---|
| 版本 | **v2.9.3** | **测试不再污染真实索引**：`test-panel` 先把真实索引的卡文件拷进临时目录、并把 `SESSION_INDEX_DIR` 指过去，再 import 宿主半身 —— 之前跑一次测试就会把**正在运行的 DSH 的 `server-path.txt`** 改成源码路径（门禁因此 FAIL，MCP 还可能被指回源码目录）。冒烟起的临时 server 也关掉面板 HTTP 通道（`SESSION_INDEX_HTTP_PORT=0`），不再和活实例抢 8799、不再把 `http-url.txt` 写成会失效的端口。README 新增「面板失效怎么查」三份日志速查表。 |
| **v2.9.2** | **真正的根因：同步模块用 `execFileSync` 跑 git，把 MCP 进程的事件循环卡住**。日志坐实：面板打开时的远端探测 `GET /api/sync/probe` 从 08:17:08.467 卡到 08:17:17.324（**8.85 秒**），期间面板的 `/api/health` 探活（900ms 超时）全部超时 → 「没有找到本地服务」→ 面板空白。git 一律改为异步 `execFile`（只剩 `gitAvailable` 保留一次本地快查并缓存），面板探活超时 900ms → 3000ms，远端探测延后 1.2 秒、不挡列表。新增回归测试：**故意慢 1.5 秒的假 git 远端 → 探测耗时 1783ms，期间面板 HTTP 6ms 秒回**。smoke 99 → 100、test-sync 51 → 54。 |
| **v2.9.1** | **面板「打不开 / 一片空白」可诊断**：面板 HTTP 通道的跨源判定放宽到「本机来源」（回环、本机名、`.localhost` 之类、本机自定义 scheme 如 `dsh-app://`），公网站点与局域网默认仍不放行（可用 `SESSION_INDEX_HTTP_ALLOW_ORIGIN` 单独放行）；面板失败时把两条通道各自的失败原因一并显示，并**自动向宿主机自报**（`<索引目录>/client-diagnostics.log`）；HTTP 服务记录每次请求的 Origin 与状态码（`<索引目录>/http-access.log`）—— 「面板空白」从此在宿主机上可定位，不用靠猜。 |
| **v2.9.0** | **另一台终端「装了就能用」**：工具不再把同步来的会话当空气 —— 守卫从「只看 meta」改成「meta 或会话卡」，`list` 补上同步来的会话（标 `imported`），`get` 在本机没原文时返回会话卡形态（结论/提问/路径，不是报错），`search` 把会话卡纳入精确与语义召回，`recall` 照常召回同步来的记忆。远端地址三级解析（环境变量 → 本机已保存 → 包内 `sync.default.json`）+ **首启自举**（本地一张卡都没有时自动拉一次），新机器不用手填地址。`sync_status` 改为只读本地，远端探测拆到 `sync_probe`（面板不再每次打开都打 git 网络）。`test-sync` 40 → 51。 |
| **v2.8.1** |
| 运行要求 | Node **≥ 22.15**（需要 `zlib.zstdDecompressSync`） |
| MCP 能力 | **14 个工具** / 4 个提示词 / 8 个资源 |
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

装完就是可用状态，不用改配置、不用跑脚本、不用管 Node 路径。「已安装」列表与详情页会显示插件图标（`icon.svg`，卡片 + 放大镜）。

> 地址带不带 `.git` 都能装：不带时 pnpm 直接走 codeload 下 tarball，**不依赖本机 git**；
> 带上 `.git` 会先做一次 `git ls-remote` 解析版本。网络抖动时前者更稳。
> 实测这两条路都能装成（本机约 80–100 秒，主要是 GitHub 往返延迟，包本身只有 83 KB）。

**它为什么能自己找到入口**——插件包里的 `cordis.patch.yml` 会随 bundle 自动应用，挂两行：

| 行 id | 包 | 作用 |
|---|---|---|
| `session-index-host` | `dsh-session-index` | 宿主半身（`lib/index.mjs`）：用 `import.meta.url` 解析**真实安装目录**，把 `server.mjs` 绝对路径写进 `~/.dsh/session-index/server-path.txt`；另注册 `session-index` 斜杠命令，并往 `~/.dsh/session-index/host-half.log` 追加自诊断行 |
| `mcp-session-index` | `@deepseek-ai/dsh-mcp-client` | MCP stdio 客户端：14 工具 / 4 提示词 / 8 资源 |

那行配置里的 `command`、`args`、`DSH_HOME` 三处都是 `!!js` 表达式，**在 DSH 加载配置时求值**（不是安装时），
按「显式环境变量 → 宿主记下的路径文件 → profile 标准安装位置」依次探测。
所以仓库放哪、pnpm 装到哪、换了 Node 版本，都不需要改文件。

宿主行排在前、MCP 行排在后，路径文件先落盘，MCP 侧首次 spawn 就能命中——**一次重启即生效**。

### 方式 B：pnpm / npm 安装（标准流程 · 推荐命令行用户）

插件已发布到 npm，包名 `dsh-session-index-lau`。在 DSH profile 目录执行：

```bash
cd ~/.dsh/profiles/desktop
pnpm add dsh-session-index-lau          # 安装
pnpm update dsh-session-index-lau       # 升级到最新版
pnpm remove dsh-session-index-lau       # 卸载
```

bundle 由包内 `cordis.patch.yml` 自动挂载，宿主半身按运行时探测解析 `server.mjs` 路径，MCP 客户端随 bundle 一起加载；安装 / 升级 / 卸载后**完全退出 DSH 再打开**即生效。

> **标准流程铁律**：所有插件更新统一走「仓库代码更新 → npm 包发布 → 插件安装更新」三段式。不再有本地 `link:` 安装、一键脚本或旧宿主兼容转发；禁止手工改 `profile/node_modules` 副本（pnpm 重装会按 registry 还原）。

> **本地迭代例外（2026-11-16 踩过）**：确实要用 `link:` 指着源码目录时，profile 里的依赖名**必须写成包自报的名字** `dsh-session-index`（不能写成 npm 名 `dsh-session-index-lau`）。
> 原因是 `cordis.patch.yml` 里那行 `session-index-host` 的 `name: 'dsh-session-index'` 会按 **profile 的 `node_modules` 目录名**解析；
> 目录叫 `-lau` 时这行解析不到 → 宿主半身不加载 → 面板一片「宿主半身没加载：会话检索面板取不到数」，
> 而 MCP 那行靠 `server-path.txt` 兜底还能跑，很容易误判成索引坏了。
> 反方向是安全的：发版时 `sync-publish.mjs` 会把包名与 patch 行名一起改成 `-lau`，npm 装出来的目录也是 `-lau`，两边一致。

### 方式 C：手动加 MCP（不推荐，仅排障用）

DSH「MCP 与技能」→ MCP 里添加 stdio server：

| 字段 | 值 |
|---|---|
| 名称 | `session-index` |
| command | `node` 的绝对路径（需 ≥ 22.15） |
| args | `<仓库目录>/server.mjs` |

### 前置条件

1. **Node ≥ 22.15** —— 需要 `zlib.zstdDecompressSync`。插件页安装时会自动挑 DSH 自带的 Node（`~/.dsh/dsh-runtimes/*/dependencies/node`），通常不用你操心。
2. 方式 B 需要 **pnpm**（DSH 自带）；从 npm registry 拉取，无需 git、无需 SSH key。

### 安装后发生了什么

`cordis.patch.yml` 随 bundle 自动应用，挂两行：`session-index-host`（宿主半身，用 `import.meta.url` 解析真实安装目录，把 `server.mjs` 绝对路径写进 `~/.dsh/session-index/server-path.txt`）与 `mcp-session-index`（MCP stdio 客户端，14 工具 / 4 提示词 / 8 资源）。

三处 `!!js` 表达式在 **DSH 加载配置时求值**（不是安装时），按「显式环境变量 → 宿主记下的路径文件 → profile 标准安装位置」依次探测，因此装到哪个目录都无需改配置，**一次重启即生效**。Skill 与分发包由插件自身在运行时生成。

---

## 插件页装不上？pnpm 排障要点

DSH 插件页装任何东西，底层都是一次 `pnpm install`。装不上时提示常被归类成
「没有写入权限，无法安装」，但**真实原因通常在 pnpm 那一步**。逐项对照排查：

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
| `session_index_stage` | 会话整理成 Markdown → 思源桥「待入库」（两步确认，绝不自动写库） |

另提供提示词 `session-context` / `resume-topic` / `catch-up` / `quickstart`，
资源 `session-index://guide`、`://plugin.json`、`://status`、`://brief`、`://memory` 等。
`initialize` 会返回 `instructions`，客户端不读外部文档也能正确上手。

**搜索模式**：`semantic`（默认，本地同义词扩展 + BM25，零 token）、`keyword`（精确 AND）、
`hybrid` / `vector`（需配置 embedding，未配置自动降级为本地语义检索）。

---

## 「会话检索」面板（侧栏）

侧栏图标「会话检索」打开 main 面板：搜索框（300 ms 防抖、Enter 立即搜、Esc 清空）+
会话卡列表（DSH 蓝 / WorkBuddy 黄左色条）+ 右侧详情（结论 / 提问 / 涉及路径 /
关键词点一下直接拿去搜 / 文件 / 工具）。

### 两条数据通道（面板自己选，优先 HTTP）

| 通道 | 谁提供 | 什么时候用 | 依赖 |
|---|---|---|---|
| **本地只读 HTTP**（首选） | **MCP 服务进程**自己开的 `127.0.0.1:8799`（占用就顺延到 8808） | 默认 | 只要 MCP 服务在跑；**不需要会话、不依赖宿主半身** |
| gateway 命令通道（兜底） | 宿主半身注册的 `session-index` 斜杠命令 | HTTP 不通时 | 需要一个活的会话 id + 宿主半身那一行加载成功 |

meta 行右侧会显示当前用的是哪条（`HTTP · 127.0.0.1:8799` / `命令通道`）。
两条都不通时给一句可操作的提示，而不是把网关报错甩给人。

**为什么优先 HTTP**：`commands/execute` 是**按 agent 作用域**的（wire 字段 `agentId`，
类型 SessionId），面板必须先借一个活会话 id 才能被寻址；会话被归档 / 壳重载之后 id 失效，
或者宿主半身那一行没加载（bundle 行名与安装目录名不一致就会这样），面板就整片取不到数。
HTTP 通道把这三层依赖全部去掉，而且**和 agent 用的是同一份索引、同一套查询实现**
（`lib/panel-api.mjs`），所以人和机器搜出来的顺序完全一致。

### 手工验证（不用开面板）

```bash
curl http://127.0.0.1:8799/api/health        # 应返回 {"ok":true,"service":"dsh-session-index","version":"2.9.3"}
curl "http://127.0.0.1:8799/api/list?limit=3"
curl "http://127.0.0.1:8799/api/search?q=%E6%8F%92%E4%BB%B6"
curl "http://127.0.0.1:8799/api/card?id=<会话id>"
```

端口记在 `~/.dsh/session-index/http-url.txt`（MCP 服务每次启动刷新）。
接口**只绑 127.0.0.1**：读接口 `GET/HEAD`；写操作只有两处 ——
`POST /api/sync/*`（同步模块，必须带 `X-Session-Index-Sync` 头）与 `POST /api/diag`（面板自诊断）。
不返回会话原文，只返回会话卡。
**跨源按源判定**：公网站点与局域网不给 CORS 头；**本机来源放行**（回环、本机主机名、
`.localhost/.local/.internal` 等后缀、`dsh-app://` `file://` 这类自定义 scheme），
需要额外放行时把 Origin 填进 `SESSION_INDEX_HTTP_ALLOW_ORIGIN`。
每次请求都记在 `~/.dsh/session-index/http-access.log`（时间 / 方法 / 路径 / Origin / 状态码）。

### 面板失效怎么查（三份日志，都在 `~/.dsh/session-index/`）

面板在**浏览器**里跑，它拿到的是数据还是被挡住，宿主机本来是看不见的 ——
所以插件专门留了三份自诊断文件。**先打开一次面板，再看这三份**：

| 文件 | 说明什么 | 怎么看 |
|---|---|---|
| `client-diagnostics.log` | **面板自己报的失败原因**：两条通道各试了什么、错在哪 | 看最后一条 `failures` 数组，里面逐条写了「HTTP 通道：…」「命令通道：…」 |
| `http-access.log` | 面板**到底请求了什么**、Origin 是什么、拿到什么状态码 | 有 `/api/list` 且 `status=200` → 服务端没问题；**没有它** → 请求没发出去或被探活超时掐了；`status=403` → 被跨源策略挡了（看 `origin=` 值） |
| `host-half.log` | 宿主半身有没有加载、命令有没有注册 | 没有 `apply` 行 = 那一行压根没被 DSH 加载；有 `apply` 没 `command registered` = `commands` 服务没就位 |

**一个已修的典型根因（v2.9.3）**：同步模块用 `execFileSync` 跑 git → **阻塞整个 MCP 进程**，
面板探活（`/api/health`）超时 → 报「没有找到本地服务」→ 面板空白。
特征是 `http-access.log` 里**面板的 health 请求被排到几秒之后才记录**（排队等 git 结束）。
现在 git 全异步，慢远端在后台跑，面板 6ms 内就有响应。

**跨源被挡**（`http-access.log` 里 `status=403` 或浏览器报 CORS 错）：
渲染进程的 `origin=` 若是本机地址应已放行；还不行就把那个 Origin 填进
`SESSION_INDEX_HTTP_ALLOW_ORIGIN`（见 `cordis.patch.yml`，逗号分隔、`*` 为全放行）。

**宿主半身没加载**（`client-diagnostics.log` 的 failures 里出现这句话）：
查 `cordis.patch.yml` 里 `session-index-host` 的 `name` 与 profile `node_modules` 里的**目录名**
是否一致 —— `link:` 安装时必须用包自报名 `dsh-session-index`（见上文「本地迭代例外」）。

---

## 跨终端同步（面板 → 私有数据仓）

把**会话卡 + 长期记忆**推到一个 GitHub **Private** 仓；另一台装了本插件的机器拉取合并后，
也能搜到这台机器的历史结论与记忆。功能本身（插件、技能、面板、14 个工具）**不需要同步** ——
它们随插件安装走，另一终端 `pnpm add` / 插件页安装即得。

### 面板四步

1. 面板 meta 行右侧点 **「同步」**；
2. 远端地址**通常不用填** —— 它按「环境变量 → 本机已保存 → 包内默认」三级解析
   （包内 `sync.default.json` 带着默认仓地址，所以新机器装上就知道跟谁同步）；
   要换成别的仓再填 → **保存地址**；
3. **上传到远端**（本机 → 仓）；
4. 另一台机器装好插件 → 它会**首启自动拉一次**（本地一张会话卡都没有时才拉，不会覆盖本机数据），
   面板顶部也会出现「远端有新数据（N 张会话卡）」横幅，点一下即合并。

不想让地址随包公开就删掉包里的 `sync.default.json`（会退回面板里手填）；
某台机器明确不接默认地址：设 `SESSION_INDEX_SYNC_NO_DEFAULT=1`。

也可以不走 git：**导出 zip** 生成 `~/.dsh/session-index/exports/session-index-data-<时间>.zip`，
拷到另一台机器用「导入合并」打开（同样是合并，不会覆盖那边的新数据）。

### 另一台终端拉取之后，agent 怎么用

同步过来的是**会话卡 + 长期记忆**（不含会话原文），工具侧已经适配：

| 工具 | 同步来的会话怎么表现 |
|---|---|
| `session_index_brief` | 正常返回这些会话的**结论 / 提问 / 关键词** ✔ |
| `session_index_search` | 会话卡也进召回集（标题+提问+结论+关键词），**同步来的内容搜得到** ✔ |
| `session_index_list` | 会列出它们，并标 `imported: true`（本机没有原文） ✔ |
| `session_index_get` | 本机没原文时返回 `mode: "card"`：结论 / 提问 / 涉及路径 / 关键词（不是报错） ✔ |
| `session_index_recall` | 同步来的**长期记忆**照常召回 ✔ |
| `session_index_get` 取原文 | ✘ 原文不同步 —— 要看原文得去产生它的那台机器 |

> 一句话：**另一台终端装上插件、拉完数据，agent 立刻就能用上这边的历史结论与记忆**；
> 只有「逐句原文」这一层拿不到 —— 那是刻意不传的（几十 MB 且含隐私）。

### 同步范围与合并语义

| | 内容 | 说明 |
|---|---|---|
| **同步** | `cards.json` 会话卡、`notes.json` 长期记忆 | 几百 KB；另一终端可 `brief / search / related / card` + 记忆召回 |
| **不同步** | 记录分片 `*.jsonl.gz`（会话原文） | 几十 MB 且含隐私；另一终端 `get` 取不到原文是**取舍不是缺陷** |
| **不同步** | `meta.json`、`host-half.log`、`sync.json`、`sync-remote/` | 本机派生数据 / 本机状态 |

**合并，绝不覆盖**：同 id 取 `updatedAt` 更新的那份；两边独有的都保留；记忆再按「类型 + 文本」
去重一次（两台机器各自 `remember` 同一句话不会变成两条），标签取并集、重要度取最大。
push 与 pull 是**同一个 union 合并**，区别只是最后要不要把结果推上去。

**幂等**：进仓的文件做了规范化（对象键递归排序、记忆排序、抹掉本机时间戳），
所以「同样的数据 → 同样的字节」，重复推送是 `changed: false`，两台机器不会互相追着时间戳提交。

### 手工验证 / 排障

```bash
curl -H "X-Session-Index-Sync: 1" http://127.0.0.1:8799/api/sync/status
curl -X POST -H "X-Session-Index-Sync: 1" -H "Content-Type: application/json" \
     -d '{"repo":"git@github.com:你/dsh-session-index-data.git"}' http://127.0.0.1:8799/api/sync/config
curl -X POST -H "X-Session-Index-Sync: 1" -d '{}' http://127.0.0.1:8799/api/sync/push
curl -X POST -H "X-Session-Index-Sync: 1" -d '{}' http://127.0.0.1:8799/api/sync/pull
```

- **没有 git**：接口会明说「这台机器没有 git 命令」；装 git 即可。
- **认证失败 / Repository not found**：SSH key 没加到 GitHub，或仓不是 Private / 还没创建。
- **远端没有数据**：先在一台机器点「上传」。
- **挂起**：不会 —— git 一律 `GIT_TERMINAL_PROMPT=0` + `BatchMode=yes`，需要交互时直接报错退出，
  绝不把 MCP 进程吊在那等输入。

### 写接口的防护

`/api/sync/*` 是本插件**唯一会写盘/调 git** 的一组接口，三道闸：

1. 只绑 `127.0.0.1`；
2. **Origin 按源判定**（远程 http(s) 网站不给 CORS 头，预检直接 403）；
3. **必须带 `X-Session-Index-Sync: 1` 头** —— 自定义头强制浏览器先发预检，
   远程网页的 `no-cors` 简单请求到不了服务端（否则能被网页偷偷触发拉取）。

`import` 只接受 `exports/` 目录下的 zip，不给借道读任意路径。

---

## 会话整理 → 思源桥「待入库」

`session_index_stage` 把索引里的会话卡、结论、检索片段整理成一篇 Markdown，**投递到思源桥的待入库队列**。
它只做「投递」这一步，**绝不调用 `/api/stage/commit`**——写进思源笔记库永远由你在思源桥界面点确认。

### 为什么不用再做一个插件

DSH 的插件之间**不共享会话数据**：会话本体只有一份磁盘文件，各插件各自解析、各自维护私有目录。
但会话卡与结论已经在 `session-index` 手里，而思源桥是独立的 HTTP 服务（默认 `127.0.0.1:5599`），
所以一次 HTTP 调用就能对接，不需要 DSH 内核级的插件通信，更不需要第三个插件重新解一遍 zstd。

### 三步用法

```text
1) 只读探测（可选）
   session_index_stage { "status": true }
   → 返回思源桥内核版本、队列篇数、自动接入目录

2) 预览（默认，不产生任何写入）
   session_index_stage { "query": "插件", "template": "brief", "limit": 5 }
   → 返回 title / chars / preview / token / target / confirmWith

3) 用户看过预览、点头后，把 confirmWith 原样回传
   session_index_stage { ...confirmWith }
   → 投递到「待入库」；返回 id 与落点
```

第 2 步**永远只是预览**。第 3 步的 `confirmToken` 绑定了「标题 + 落点 + 正文」，
参数被改动或索引刚更新导致内容变化时令牌失配，会直接拒绝投递并要求重新预览——不会出现「预览 A、投递 B」。

### 主要参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `status` | false | 只读探测服务与队列，不做任何写入 |
| `query` | 空 | 主题词，按主题聚合会话 |
| `sessionIds` | 空 | 精确指定会话 id（支持前缀），不传则取最近/相关会话 |
| `app` / `workspace` / `since` / `until` | all / 空 | 范围过滤 |
| `template` | `brief` | `brief` 速览 / `decisions` 只要结论 / `detail` 附检索片段 |
| `title` | 自动生成 | 自定义文档标题（确认时回传预览给出的值） |
| `hpath` / `notebook` | `/会话札记/思源` / `思源桥` | 落点；**写入前仍可在思源桥界面改** |
| `note` / `limit` / `maxChars` | 自动 / 8 / 12000 | 备注、会话数、篇幅上限 |
| `confirmToken` | 空 | 预览返回的令牌；带上且匹配才真正投递 |

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `SIYUAN_BRIDGE_PORT` / `SIYUAN_BRIDGE_URL` | `5599` / `http://127.0.0.1:5599` | 服务地址；**只允许回环地址**，不接受任意内网 URL |
| `SESSION_INDEX_STAGE` | `1` | 设 `0` 彻底禁用该工具 |
| `SESSION_INDEX_STAGE_TIMEOUT_MS` | `5000` | 单次请求超时（1000–60000） |
| `SESSION_INDEX_STAGE_HPATH` / `_NOTEBOOK` | `/会话札记/思源` / `思源桥` | 默认落点 |

### 安全边界

- 只调用 `/api/status`、`/api/stage`（GET/POST）、`/api/autostage`，**不调用 commit**
- 投递前按「标题 + 字数」查队列，已有同稿则不重复入队
- 服务不可达时返回结构化错误（`BRIDGE_UNREACHABLE`），不抛堆栈、不影响其它 13 个工具
- 文档硬上限 60000 字；Markdown 里明确标注「未写入笔记库」

> 实测提醒：思源桥 `/api/autostage` 返回的实际 `session-docs` 目录可能与 `config.json` 里的
> `dataDir` 不一致（服务走 `SIYUAN_BRIDGE_DATA` 推导）。本工具走 HTTP 接口，不受这个差异影响。

### 推送已有文档（手册 / README）

`session_index_stage` 整理的是**索引里的会话**；如果要把仓库里现成的文档送进待入库，
用独立脚本 `tools/push-doc.mjs`（不需要重启 DSH、不依赖 MCP 服务）：

```bash
node tools/push-doc.mjs                                   # 只读预览《操作使用手册.html》
node tools/push-doc.mjs --send                            # 投递到待入库（绝不写库）
node tools/push-doc.mjs --file README.md --dry            # 推别的文件
node tools/push-doc.mjs --hpath "/会话札记/运维" --send    # 指定落点
```

**批量：WorkBuddy 所有会话生成的文档**

```bash
node tools/push-doc.mjs --from-workbuddy                  # 只列清单（默认，零写入）
node tools/push-doc.mjs --from-workbuddy --send           # 全部投递到待入库
node tools/push-doc.mjs --from-workbuddy --no-exclude     # 连临时/备份目录一起
node tools/push-doc.mjs --from-workbuddy --include-txt    # 连 .txt 一起
node tools/push-doc.mjs --from-workbuddy --source PresentFiles --limit 10 --send
node tools/push-doc.mjs --from-workbuddy --seed         # 只记状态基线，不投递任何文档
```

数据源是 `~/.workbuddy/artifact-index/<会话id>.json` 里 `contentType: document` 的条目
（`WORKBUDDY_ARTIFACT_INDEX` 可改）。默认会**排除** `node_modules/dist/.git`、`.verify-*`、
`DSH-probe`、旧开发副本 `dsh-session-index`、备份与 UI 源码，并按**内容哈希 + 路径**去重，
避免同一份 README 被推十几遍。每篇标题带相对路径、备注带来源会话，落点统一可在界面改。

实测（2026-11-14）：70 条文档命中 → 排除 26 条临时/依赖 → 文件已不存在 4 →
路径或内容重复 18 → **唯一 22 篇全部投递成功**，队列 23 篇（含此前单推的手册）。
可用 `--limit`（默认 60）与 `--since` 收窄。

**判重：对齐思源桥 `autoStage` 的 `.auto-staged.json`，但丢弃后不重新获取。**

状态文件 `~/.dsh/session-index/push-doc-state.json`（`PUSH_DOC_STATE` 可改）按
「文档路径 + 内容 sha256」记录已推送过的文档，**判重不看队列里还在不在**：

- 在思源桥里「丢弃」某篇 → 下次自动化**不会**把它重新推送回来
- 队列被清空、服务重启、定时任务重跑 → 同样不会重复入队
- 内容真的改了 → 作为新版本投递一次，之后又不再重复
- `--force` 可强制绕过；`--seed` 只写状态基线、不投递（首次启用或迁移时用）

- **默认只预览**，加 `--send` 才入队；预览写到 `dist/push-doc-preview.md`
- HTML 会先裁掉侧栏导航、复制按钮、脚本、样式与统计卡，再用思源桥自带的
  `/api/paste/html`（只读）转成 Markdown，不会把界面文字塞进笔记
- 同样**只入队、不 commit**，写入仍由你在思源桥界面确认

### 插件怎么更新（DSH 插件页有没有「更新」按钮）

**有，但只对特定安装来源显示**，这是 DSH 插件页的规则（从 DSH 内置文档确认）：

| 安装来源 | 更新方式 |
|---|---|
| 注册表（npm）安装的第三方组合包 | 详情页有「版本」区块与**更新**按钮，可查新版本并升级 |
| Git 仓库安装的组合包（`update: 'git'`） | 通过「发现」页 / 详情页的**更新到**升级 |
| 官方按需插件 | 有显式**更新**（版本或开发链接来源不同时） |
| **本地路径 / `link:` / 压缩包安装的** | **不显示版本区块**，文档写明「通过卸载后重新安装升级」 |

**本机当前是 npm registry 来源**（2026-11-18 v2.9.3 发布后切回）：profile 依赖是
`"dsh-session-index-lau": "^2.9.3"`，属于上表第一行 —— 插件页**有「版本」区块与「更新」按钮**，
以后发新版后**点更新即可，不需要卸载重装**；命令行 `pnpm update dsh-session-index-lau` 与点按钮同一条路。

> ⚠ 切回 npm 后，改本机代码**不再即时生效**：要走「改仓库 → 发布 npm → 插件页更新 →
> 完全退出 DSH 再打开」。想边改边看效果时，把 profile 依赖临时指回源码目录
> （`"dsh-session-index": "link:<源码目录>"` + bundles 同名 + 删掉 `-lau` 那条），
> 但**依赖名必须用包自报名**，否则 bundle patch 里 `session-index-host` 那一行解析不到，
> 宿主半身不加载、面板会假死（详见上文「本地迭代例外」与「面板报宿主半身没加载怎么办」）。

发布侧走**随仓库走的**标准流程（`tools/publish/`，三个插件共用同一套工具）：

```bash
cd tools/publish
node sync-publish.mjs session-index                       # ④ 生成改名后的发布副本并自检
node check-release.mjs session-index --pre                # ④.5 发布前门禁（未全绿禁止发布）
cd <副本根>/dsh-session-index-lau && npm publish --access public
# 等 npm staged publishing 生效（实测 1~8 分钟）
cd ~/.dsh/profiles/desktop && npx -y pnpm@11.28.5 update dsh-session-index-lau@<新版本>
node check-release.mjs session-index --post               # ⑧ 安装后核验（版本四处统一 + MCP 握手）
```

完整流程见 [`tools/publish/插件发布标准流程.md`](./tools/publish/插件发布标准流程.md)；
换机器时复制 `tools/publish/config.example.json` 为 `config.local.json` 改路径即可，
**脚本一行都不用改**（路径解析见 `tools/publish/paths.mjs`）。

注意 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 要同步登记新版本，
否则供应链冷却期会让 pnpm 静默回退旧版。更新后**完全退出 DSH 再打开**，
运行中的 MCP 子进程才会换成新版。

> 只有从本地路径 / `link:` / 压缩包安装的才没有更新按钮（需卸载重装）；
> 这类挂载因为直接指向仓库目录，`git pull` + 重启即生效，同样不用重装。
> 发布给别人用需要 `git push` + `npm publish`；本机开发目录则 `git pull` 即可。

---

## 更新 / 校验 / 回滚

```bash
cd ~/.dsh/profiles/desktop
pnpm update dsh-session-index-lau       # 升级（先在 pnpm-workspace.yaml 登记 包名@精确版本 豁免供应链冷却期）
pnpm remove dsh-session-index-lau       # 卸载
```

源仓库开发时的自检命令：

```bash
node pack.mjs                    # 重新生成插件包 + 技能包
node build-index.mjs --force     # 全量重建索引
node smoke.mjs                   # 端到端自测（含标准形态断言）
```

---

## 分发包（离线 / 无 git 环境）

`node pack.mjs` 可随时重新生成（打包由 `lib/pack.mjs` 完成，纯 Node 零依赖）：

| 文件 | 内容 | 用途 |
|---|---|---|
| `dist/dsh-session-index-v2.9.3.zip` | 全部源码 + 清单 + 文档 + 手册 + 脚本 + `MANIFEST.json` + `INSTALL.md` | 完整分发，按标准流程 `pnpm add` 安装 |
| `dist/session-index-skill-v2.9.3.zip` | 根 `SKILL.md` + 说明 | 直接导入 DSH「MCP 与技能」 |

包内**排除**：索引分片 `*.jsonl.gz`、`meta/cards/notes/vectors.json`、备份与临时文件、已有 zip。
已验证包内无任何会话数据与密钥，可安全分发。也可调 MCP 工具 `session_index_package` 触发打包。

---

## 配置项

全部通过配置块的 `env` 设置。改哪里取决于安装方式：

- **插件页安装**：改插件包内的 `cordis.patch.yml`（`<profile>/node_modules/dsh-session-index/cordis.patch.yml`），改完重启 DSH；
- **pnpm 安装**：改已装包内的 `cordis.patch.yml`（`<profile>/node_modules/dsh-session-index-lau/cordis.patch.yml`）里的 `env`；升级会还原默认值，如需长期自定义建议用环境变量。

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

> 环境变量方式优先级最高，且升级不会覆盖，推荐用它替代改包内文件。

---

## 目录结构

```text
dsh-session-index/                  # 仓库根 = 插件根
├── server.mjs                      # MCP stdio server（14 工具 / prompts / resources）
├── cordis.patch.yml                # bundle patch：挂宿主行 + MCP 行（含 !!js 自解析路径）
├── build-index.mjs                 # 索引构建（多帧 zstd → 可检索记录 + 会话卡）
├── pack.mjs                        # 打包 CLI（零依赖 ZIP writer）
├── smoke.mjs                       # 98 项端到端自测
├── test-panel.mjs                  # 面板 + 本地 HTTP 通道 91 项单测
├── test-sync.mjs                   # 跨终端同步 40 项单测（本地裸仓当远端，不联网）
├── icon.svg                        # 插件页图标（package.json 的 icon 字段指向它）
├── plugin.json                     # 机器可读能力清单（也通过 MCP 资源暴露）
├── package.json                    # 元信息 + dsh.bundle.patch + dsh.plugin 声明
├── 操作使用手册.html                # 自包含单页手册（14 章）
├── lib/
│   ├── index.mjs                   # 宿主半身：解析自身安装路径 + 斜杠命令 + 自诊断日志
│   ├── client.js                   # 浏览器半身：侧栏「会话检索」面板（HTTP 优先、命令兜底、同步模块）
│   ├── panel-api.mjs               # 面板 / 斜杠命令 / HTTP 共用的查询实现（唯一口径）
│   ├── http-api.mjs                # 本地只读 HTTP + /api/sync/*（面板主通道，127.0.0.1:8799 起）
│   ├── sync.mjs                    # 跨终端同步：合并语义 + git 推拉 + 本地 zip 导入导出
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
│   ├── pack.mjs                    # ZIP writer
│   └── stage.mjs                   # 会话整理 → 思源桥待入库（渲染 + HTTP 投递）
├── skill/SKILL.md                  # 自动接入用技能
├── tools/push-doc.mjs             # 推送任意 md/html 到思源桥待入库（默认只读预览）
├── tools/publish/                 # 跨插件共用的发布工具链（随仓库走版本，见其 README）
│   ├── 插件发布标准流程.md          # 完整发布流程 ①→⑨
│   ├── sync-publish.mjs           # ④ 同步 npm 发布副本（改名 + 发布化 + 自检）
│   ├── check-release.mjs          # ④.5 / ⑧ 发布核验门禁
│   ├── update-plugin.mjs          # ⑦ 安装更新助手
│   └── paths.mjs                  # 路径解析（换机器改 config.local.json 即可）
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
- **pnpm 安装的**：`pnpm remove dsh-session-index-lau`，或在插件页禁用 / 卸载；MCP 行随 bundle 一起消失。

两种情况下索引目录 `~/.dsh/session-index/` 都保留（不影响原始会话），需要时手动删除。

---

## 变更记录

| 版本 | 变更 |
|---|---|
| **v2.8.0** | 新增**跨终端同步**（面板「同步」模块 + `lib/sync.mjs` + `/api/sync/*`）：把**会话卡 + 长期记忆**推到 GitHub **Private** 数据仓，另一台终端拉取合并即可继续搜到历史结论；**不同步会话原文分片**（取舍，已写明）。合并是 union（同 id 取新、两边独有都保留、记忆按类型+文本去重、标签取并集），**绝不覆盖**；进仓字节做规范化（键排序 + 抹掉本机时间戳），重复推送 `changed: false`，两台机器不会互相追着时间戳提交。面板另有**本地导出 / 导入 zip**（不走 git 的手动搬运）。写接口三道闸：只绑回环 + Origin 按源判定 + 必须带 `X-Session-Index-Sync` 头（堵 `no-cors` CSRF），`import` 只认 `exports/` 目录。新增 `test-sync.mjs` 40 项（本地裸仓当远端，A推→B拉→B推→A拉双向验证）；`smoke` 93 → 98。 |
| **v2.7.0** | **面板改为「配合 MCP 用」**：新增 `lib/http-api.mjs` —— MCP 服务进程自己开一个**本地只读 HTTP**（`127.0.0.1:8799` 起，占用顺延到 8808），面板优先直连它取数，**不再需要会话 id、不再依赖宿主半身那一行**；命令通道降级为兜底。新增 `lib/panel-api.mjs` 作为**面板 / 斜杠命令 / HTTP 三条出口共用的唯一查询实现**（排序与 `session_index_brief` 同源），删掉宿主半身里那套朴素打分，人和机器搜出来的顺序从此一致。宿主半身补 `host-half.log` 自诊断（面板报「宿主半身没加载」时看这个文件即可定位）。面板 meta 行显示当前数据通道（`HTTP · 127.0.0.1:8799` / `命令通道`）。`sync-publish` 的 renameFiles 补进 `lib/client.js`（npm 用户的客户端模块 id 跟包名走）。`test-panel` 68 → 91、`smoke` 86 → 93。 |
| **v2.6.0** | 新增**「会话检索」面板**（侧栏入口 + main 面板）：搜索框 + 会话卡列表（DSH 蓝 / WorkBuddy 黄左色条）+ 右侧详情（结论 · 提问 · 涉及路径 · 关键词 · 工具）。数据走宿主半身注册的 `session-index` 命令（`ctx.remote.commands.execute`），**浏览器半身不碰文件系统**；宿主半身没加载时给一句人话提示而不是静默失败。新增 `test-panel.mjs`（57 项），版本一致性改为跟 `package.json` 对齐 |
| **v2.5.3** | 移除整套「本地 link 安装 + 一键脚本」机制：删除 `install.mjs` / `install.cmd` / `install.sh` / `update.cmd` / `update.sh`，回归纯 npm 包形态（bundle 由 `cordis.patch.yml` 自动挂载）。`package.json` 去掉 `setup`/`verify`/`uninstall` 脚本与安装器白名单，`plugin.json` 删除 `automatic` 旧安装键与「手工安装」方式；安装 / 升级 / 卸载统一走 `pnpm add` / `pnpm remove`。README 与操作手册同步改为标准流程说明，smoke 增加标准形态断言防回潮。 |
| **v2.5.2** | 发布流程标准化：新增发布前/后核验门禁（`dist/publish/check-release.mjs`），把「检查并核验 → 确认版本可用 → 才推进标准流程」固化为强制步骤；标准流程文档同步新机制（批量推送、持久化判重、定时自动化）与版本统一矩阵。把源仓库已生效的持久化判重脚本同步进发布包与 DSH 安装，消除「同版本号、内容不同」的分叉。 |
| **v2.5.1** | `tools/push-doc.mjs` 增加 **`--from-workbuddy` 批量模式**：扫描 WorkBuddy 全部会话产出的文档，按内容哈希去重、排除临时/依赖目录、逐篇查重后一次性投递到思源桥待入库；默认只读预览，`--send` 才入队，`--no-exclude` / `--include-txt` / `--source` / `--limit` / `--since` / `--force` 可控。修掉按 `chars` 判重不稳的问题（思源桥会规整正文）。README 补「插件怎么更新」章节。 |
| **v2.5.0** | 新增第 14 个工具 `session_index_stage`：**会话整理文档 → 思源桥「待入库」队列**。两步确认（预览返回令牌，原样回传 `confirmWith` 才投递）、按标题+字数去重、支持主题/指定会话/三种模板/落点配置，**绝不自动写入思源笔记库**。读取状态与队列可传 `status: true`。 |
| **v2.4.1** | 新增 `install.mjs --doctor` **环境体检**（7 项，只读），覆盖插件页安装失败的四个真实成因：git URL 重写镜像、pnpm `fetch-timeout` 超上限、远端大 tarball、lockfile 残留 `git+ssh`。README 增加「插件页装不上」排障章节。 |
| **v2.4.0** | 支持 **DSH 插件页直接安装**：新增 `dsh.bundle.patch` 声明与 `cordis.patch.yml`（含 `!!js` 自解析表达式），新增宿主半身 `lib/index.mjs`。安装路径由运行时探测，不再依赖手工配置；`install.mjs` 自动识别 bundle 模式，避免与插件页安装重复注册。仓库转公开。 |
| v2.3.0 | 仓库收敛为单插件，仓库根即插件根；新增 `install.cmd/sh`、`update.cmd/sh`；重装保留手工改过的 env。 |
| v2.2.0 | 新增文件事件驱动的免重启识别（`fs.watch` + 静止期）、MCP 变更通知。 |
| v2.1.0 | 新增跨会话关联 / 血缘链 / 长期记忆（`remember` / `recall` / `forget`）。 |
| v2.0.0 | 从「全文检索」重构为「会话卡 + 结构化速览」。 |

---

## 许可

MIT
