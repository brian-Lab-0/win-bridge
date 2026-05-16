@echo off
REM ──────────────────────────────────────────────────────────────────────
REM  Spaces Bridge — one-click installer for Windows
REM  Checks Node, installs uv (for Windows-MCP), installs deps, generates
REM  config, and starts the bridge. No prior coding experience needed.
REM ──────────────────────────────────────────────────────────────────────

setlocal EnableExtensions EnableDelayedExpansion
title Spaces Bridge - Installer
cd /d "%~dp0"

echo.
echo  ============================================================
echo    Spaces Bridge - Installer
echo  ============================================================
echo.

REM ─── 1) Node.js ───────────────────────────────────────────────────────
echo  [1/5] Checking for Node.js...
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 goto :install_node

for /f "tokens=*" %%v in ('node -v 2^>nul') do set "NODE_VER=%%v"
echo        Found Node !NODE_VER!
goto :check_uv

:install_node
echo        Node.js not found.
where winget >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo  [!] winget is unavailable on this system.
  echo      Install Node.js 18 LTS or newer from https://nodejs.org
  echo      then re-run install.bat
  pause
  exit /b 1
)
echo        Installing Node.js LTS via winget...
winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
if %ERRORLEVEL% NEQ 0 (
  echo  [!] Node install failed. Install manually from https://nodejs.org and re-run.
  pause
  exit /b 1
)
echo.
echo  [!] Node.js installed. Close this window, open a NEW PowerShell,
echo      and run install.bat again so the PATH refreshes.
pause
exit /b 0

REM ─── 2) uv (for Windows-MCP) ─────────────────────────────────────────
:check_uv
echo  [2/5] Checking for uv (Python toolchain for Windows-MCP)...
where uvx >nul 2>&1
if %ERRORLEVEL% EQU 0 (
  for /f "tokens=*" %%v in ('uv --version 2^>nul') do set "UV_VER=%%v"
  echo        Found !UV_VER!
  goto :prefetch_mcp
)

echo        uv not found. Installing via winget...
where winget >nul 2>&1
if %ERRORLEVEL% NEQ 0 goto :install_uv_ps

winget install -e --id astral-sh.uv --silent --accept-source-agreements --accept-package-agreements
if %ERRORLEVEL% EQU 0 goto :uv_path_warn

:install_uv_ps
echo        winget not available - falling back to PowerShell installer...
powershell -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 ^| iex"
if %ERRORLEVEL% NEQ 0 (
  echo  [!] uv install failed. See https://docs.astral.sh/uv/getting-started/installation/
  pause
  exit /b 1
)

:uv_path_warn
echo.
echo  [!] uv installed. Close this window, open a NEW PowerShell,
echo      and run install.bat again so the PATH refreshes.
pause
exit /b 0

REM ─── 3) Pre-fetch Windows-MCP ────────────────────────────────────────
:prefetch_mcp
REM Skip the slow prefetch if the user has already started the bridge once
REM (uv keeps a per-user package cache; once cached, future runs are instant).
if exist "%LOCALAPPDATA%\uv\cache\archive-v0" goto :npm_install
if exist "%USERPROFILE%\.cache\uv"             goto :npm_install
if exist "node_modules\ws\package.json"        goto :npm_install

echo  [3/5] Pre-fetching Windows-MCP package (one-time, ~30 seconds)...
REM Cache the package so the first bridge run is fast. Background-launch then kill.
start /b "" cmd /c "uvx windows-mcp 1>nul 2>nul"
REM Give it a few seconds to download, then stop the test instance.
timeout /t 8 /nobreak >nul
taskkill /F /IM uvx.exe /T >nul 2>&1
taskkill /F /IM python.exe /FI "WINDOWTITLE eq windows-mcp*" >nul 2>&1
echo        Windows-MCP cached.

REM ─── 4) npm install + config ─────────────────────────────────────────
:npm_install
echo  [4/5] Installing bridge dependencies...
REM Check for the actual `ws` package, not just node_modules — a half-finished
 REM install leaves an empty folder around and would otherwise be skipped.
if not exist "node_modules\ws\package.json" (
  call npm install --no-audit --no-fund
  if !ERRORLEVEL! NEQ 0 (
    echo  [!] npm install failed. Check the error above.
    pause
    exit /b 1
  )
) else (
  echo        Dependencies already installed - skipping npm install.
)

if not exist config.json (
  echo        Generating config.json...
  node scripts\setup-config.js
) else (
  echo        config.json already exists - keeping yours.
)

REM ─── 5) Launch ───────────────────────────────────────────────────────
echo  [5/5] Starting the bridge...
echo.
echo  ============================================================
echo    Setup complete. Starting Spaces Bridge.
echo    Leave this window open while you use win-connect.
echo    Press Ctrl+C in this window to stop the bridge.
echo  ============================================================
echo.
node bridge.js
echo.
echo  [bridge stopped]
pause
endlocal
