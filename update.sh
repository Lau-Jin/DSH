#!/usr/bin/env bash
# dsh-session-index 更新（git pull + 重装，保留手工改过的 env）
set -uo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PLUGIN_DIR" || exit 1

echo "============================================================"
echo "  dsh-session-index 更新"
echo "  目录: $PLUGIN_DIR"
echo "============================================================"
echo

if [ -d "$PLUGIN_DIR/.git" ]; then
  echo "[1/3] 拉取最新代码..."
  if ! git pull --ff-only; then
    echo
    echo "[警告] git pull 失败（网络或 SSH key 问题），继续用当前版本重装。"
  fi
else
  echo "[跳过] 当前目录不是 git 仓库（可能是解压安装的 zip）。"
  echo "       如需更新，请重新 clone 仓库后覆盖本目录。"
fi

echo
echo "[2/3] 重新安装（会保留你手工改过的 env 配置）..."
if ! node install.mjs; then
  echo
  echo "[失败] 更新未完成，请查看上方错误信息。"
  exit 1
fi

echo
echo "[3/3] 校验..."
node install.mjs --verify
RC=$?

echo
echo "============================================================"
echo "  更新完成。完全退出 DSH 再打开即可用新版本。"
echo "============================================================"
exit $RC
