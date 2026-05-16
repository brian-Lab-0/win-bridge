@echo off
REM Spaces Bridge - quick start (after install.bat has been run once)
title Spaces Bridge
cd /d "%~dp0"

if not exist node_modules (
  echo node_modules missing - run install.bat first.
  pause
  exit /b 1
)
if not exist config.json (
  echo config.json missing - generating defaults...
  node scripts\setup-config.js
)

node bridge.js
pause
