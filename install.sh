#!/usr/bin/env bash
# dsh-session-index 一键安装（macOS / Linux / Git Bash）
# 用法: ./install.sh              安装
#       ./install.sh --verify     校验
#       ./install.sh --uninstall  回滚
set -uo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PLUGIN_DIR" || exit 1

echo "============================================================"
echo "  dsh-session-index 一键安装"
echo "  插件目录: $PLUGIN_DIR"
echo "============================================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未找到 node。请先安装 Node.js 22.15 或更高版本: https://nodejs.org/"
  exit 1
fi

NODE_VER="$(node -v 2>/dev/null || echo unknown)"
echo "[1/3] Node 版本: $NODE_VER"

echo "[2/3] 安装中：写入 MCP 配置、安装 Skill、自动生成分发包..."
if ! node install.mjs "$@"; then
  echo
  echo "[失败] 安装未完成，请查看上方错误信息。"
  exit 1
fi

echo
echo "[3/3] 校验安装状态..."
node install.mjs --verify
RC=$?

echo
echo "============================================================"
echo "  安装完成，之后日常无需再运行任何命令。"
echo "  · 新会话由文件事件自动识别，无需重启 DSH"
echo "  · 若 DSH 里工具列表未刷新: 完全退出 DSH 再打开"
echo "  · 完整手册: 操作使用手册.html"
echo "  · 校验: ./install.sh --verify    回滚: ./install.sh --uninstall"
echo "============================================================"
exit $RC
