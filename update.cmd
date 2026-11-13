@echo off
rem Pure ASCII output on purpose: cmd.exe mis-parses UTF-8 .cmd files.
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>nul
title dsh-session-index updater

set "PLUGIN_DIR=%~dp0"
if "%PLUGIN_DIR:~-1%"=="\" set "PLUGIN_DIR=%PLUGIN_DIR:~0,-1%"

echo ============================================================
echo   dsh-session-index updater (git pull + reinstall)
echo   Dir: %PLUGIN_DIR%
echo ============================================================
echo.

if not exist "%PLUGIN_DIR%\.git" (
  echo [SKIP] Not a git repo ^(probably installed from a zip^).
  echo        To update, delete this folder and clone the repo again.
  goto :reinstall
)

echo [1/3] Pulling latest code...
git -C "%PLUGIN_DIR%" pull --ff-only
if errorlevel 1 (
  echo.
  echo [WARN] git pull failed ^(network or auth^), reinstalling current version.
)

:reinstall
echo.
echo [2/3] Reinstalling ^(your custom env values are preserved^)...
pushd "%PLUGIN_DIR%"
node install.mjs
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
echo   Update done. Fully quit DSH and reopen to load the new version.
echo ============================================================
if "%~1"=="" pause
exit /b !RC2!

:fail
echo.
echo [FAILED] Update did not complete. See the errors above.
if "%~1"=="" pause
exit /b 1
