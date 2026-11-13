@echo off
rem Pure ASCII output on purpose: cmd.exe mis-parses UTF-8 .cmd files
rem (multibyte chars break the parser), so keep every echo line ASCII.
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>nul
title dsh-session-index installer

set "PLUGIN_DIR=%~dp0"
if "%PLUGIN_DIR:~-1%"=="\" set "PLUGIN_DIR=%PLUGIN_DIR:~0,-1%"

echo ============================================================
echo   dsh-session-index installer
echo   Plugin dir: %PLUGIN_DIR%
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found.
  echo         Install Node.js 22.15 or newer from https://nodejs.org/
  echo         then reopen this window and retry.
  goto :fail
)

for /f "delims=" %%v in ('node -v 2^>nul') do set "NODE_VER=%%v"
echo [1/3] Node version: !NODE_VER!

echo [2/3] Installing: MCP config, Skill, packages...
pushd "%PLUGIN_DIR%"
node install.mjs %*
set "RC=%ERRORLEVEL%"
popd
if not "!RC!"=="0" goto :fail

echo.
echo [3/3] Verifying...
pushd "%PLUGIN_DIR%"
node install.mjs --verify
set "RC2=%ERRORLEVEL%"
popd

echo.
echo ============================================================
echo   Done. No further commands are needed for daily use.
echo   - New sessions are picked up automatically ^(no DSH restart^)
echo   - If tools do not show up: fully quit DSH and reopen it
echo   - Manual: open the HTML manual in this folder
echo   - Verify: install.cmd --verify     Rollback: install.cmd --uninstall
echo ============================================================
if "%~1"=="" pause
exit /b !RC2!

:fail
echo.
echo [FAILED] Installation did not complete. See the errors above.
echo          Common causes: Node older than 22.15, DSH config not found.
if "%~1"=="" pause
exit /b 1
