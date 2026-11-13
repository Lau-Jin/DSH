@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>nul
title dsh-session-index 更新

set "PLUGIN_DIR=%~dp0"
if "%PLUGIN_DIR:~-1%"=="\" set "PLUGIN_DIR=%PLUGIN_DIR:~0,-1%"

echo ============================================================
echo   dsh-session-index 更新（git pull + 重装）
echo   目录: %PLUGIN_DIR%
echo ============================================================
echo.

if not exist "%PLUGIN_DIR%\.git" (
  echo [跳过] 当前目录不是 git 仓库（可能是解压安装的 zip）。
  echo        如需更新，请删除本目录后重新 git clone。
  goto :reinstall
)

echo [1/3] 拉取最新代码...
git -C "%PLUGIN_DIR%" pull --ff-only
if errorlevel 1 (
  echo.
  echo [警告] git pull 失败（网络或 SSH key 问题），继续用当前版本重装。
)

:reinstall
echo.
echo [2/3] 重新安装（会保留你手工改过的 env 配置）...
pushd "%PLUGIN_DIR%"
node install.mjs
set "RC=%ERRORLEVEL%"
popd
if not "!RC!"=="0" goto :fail

echo.
echo [3/3] 校验...
pushd "%PLUGIN_DIR%"
node install.mjs --verify
set "RC2=%ERRORLEVEL%"
popd

echo.
echo ============================================================
echo   更新完成。完全退出 DSH 桌面端再打开即可用新版本。
echo ============================================================
if "%~1"=="" pause
exit /b !RC2!

:fail
echo.
echo [失败] 更新未完成，请查看上方错误信息。
if "%~1"=="" pause
exit /b 1
