@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先从 https://nodejs.org 安装 Node.js 22 或更高版本。
  pause
  exit /b 1
)
if not exist config.json (
  node src\cli.mjs init
  echo 首次启动已创建配置。请填写 rpcs，保持 mode 为 shadow，保存后再次双击。
  notepad config.json
  pause
  exit /b 0
)
node src\cli.mjs watch
pause
