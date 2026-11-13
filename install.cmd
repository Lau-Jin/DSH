@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>nul
title dsh-session-index 一键安装

set "PLUGIN_DIR=%~dp0"
if "%PLUGIN_DIR:~-1%"=="\" set "PLUGIN_DIR=%PLUGIN_DIR:~0,-1%"

echo ============================================================
echo   dsh-session-index 一键安装
echo   插件目录: %PLUGIN_DIR%
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 node 命令。
  echo        请先安装 Node.js 22.15 或更高版本: https://nodejs.org/
  echo        安装后重新打开本窗口再试。
  goto :fail
)

for /f "delims=" %%v in ('node -v 2^>nul') do set "NODE_VER=%%v"
echo [1/3] Node 版本: !NODE_VER!

echo [2/3] 安装中：写入 MCP 配置、安装 Skill、自动生成分发包...
pushd "%PLUGIN_DIR%"
node install.mjs %*
set "RC=%ERRORLEVEL%"
popd
if not "!RC!"=="0" goto :fail

echo.
echo [3/3] 校验安装状态...
pushd "%PLUGIN_DIR%"
node install.mjs --verify
set "RC2=%ERRORLEVEL%"
popd

echo.
echo ============================================================
echo   安装完成，之后日常无需再运行任何命令。
echo   · 新会话由文件事件自动识别，无需重启 DSH
echo   · 若 DSH 里工具列表未刷新: 完全退出 DSH 桌面端再打开
echo   · 完整手册: 操作使用手册.html
echo   · 校验: install.cmd --verify    回滚: install.cmd --uninstall
echo ============================================================
if "%~1"=="" pause
exit /b !RC2!

:fail
echo.
echo [失败] 安装未完成，请查看上方错误信息。
echo        常见原因: Node 版本过低（需 22.15+）、找不到 DSH 配置文件。
if "%~1"=="" pause
exit /b 1
