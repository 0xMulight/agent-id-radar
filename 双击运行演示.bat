@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先从 https://nodejs.org 安装 Node.js 22 或更高版本。
  pause
  exit /b 1
)
node src\cli.mjs demo
pause
