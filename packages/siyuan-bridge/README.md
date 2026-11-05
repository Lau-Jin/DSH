# dsh-siyuan-bridge

DSH（DeepSeek Harness）的「思源桥」面板插件：把 SiYuan（思源笔记）的搜索 / 阅读 / 编辑 / 导出界面
嵌进 DSH 主面板，侧栏图标「思源桥」切换。

## 依赖

- 本机需运行 siyuan-bridge 桥接服务（默认 `http://127.0.0.1:5599`，内核 `127.0.0.1:6806`）。
  服务没起时面板图标右下角显示红点；桥接服务不在本仓库内，用 `siyuan-bridge\start.cmd` 拉起。
- DSH `0.2.1-rc.3` ~ `0.3.0`（peer：`@deepseek-ai/cordis ~4.0.5`）。

## 安装

```bat
dsh plugin --profile desktop add "git+ssh://git@github.com/Lau-Jin/DSH.git#path:/packages/siyuan-bridge"
```

> 仓库是私有的，用 `git+ssh://` 形式；换成公开仓库时可用
> `git+https://github.com/Lau-Jin/DSH.git#path:/packages/siyuan-bridge`。

## 结构

- `lib/index.js`：Host 半身（注册服务 / 命令）
- `lib/client.js`：浏览器半身（侧栏面板 UI）
- `cordis.patch.yml`：bundle patch，`insert` 一行 `id: siyuan-bridge`
