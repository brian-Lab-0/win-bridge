@echo off
REM ──────────────────────────────────────────────────────────────────────
REM  Spaces Bridge - smart launcher
REM  First run    -> hands off to install.bat (full setup)
REM  Later runs   -> starts the bridge directly (instant)
REM
REM  This is the only file users need to double-click. Ever.
REM ──────────────────────────────────────────────────────────────────────

setlocal EnableExtensions
title Spaces Bridge
cd /d "%~dp0"

REM ─── Are we ready to start? ──────────────────────────────────────────
REM  We need three things:
REM    1) Node on PATH
REM    2) node_modules installed
REM    3) config.json present
REM  If anything is missing, fall through to the installer.

where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 goto :need_install

if not exist "node_modules\ws\package.json" goto :need_install
if not exist "config.json"                  goto :need_install

REM ─── Fast path ───────────────────────────────────────────────────────
echo  Spaces Bridge - starting...
echo  (Leave this window open while you use win-connect. Ctrl+C to stop.)
echo.
node bridge.js
echo.
echo  [bridge stopped]
pause
exit /b 0

REM ─── Cold path - run the installer ───────────────────────────────────
:need_install
echo  First-time setup detected - launching installer...
echo.
call install.bat
exit /b %ERRORLEVEL%

endlocal
