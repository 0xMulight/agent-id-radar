@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Agent ID Radar 沐光个人版 - 安装与配置
where node >nul 2>nul
if errorlevel 1 (
  echo 请先从 https://nodejs.org 安装 Node.js 22 或更高版本，再重新双击。
  pause
  exit /b 1
)
if not exist tools\wallet\node_modules\@binance\agentic-wallet\dist\index.js (
  echo 正在安装官方钱包 CLI。这里不会登录或下单。
  call npm install @binance/agentic-wallet@1.12.0 --prefix tools\wallet --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
if not exist data mkdir data
node setup.mjs
if errorlevel 1 (
  pause
  exit /b 1
)
echo 配置完成。可双击「双击启动观察.bat」查看发现结果。
echo 登录钱包请双击「登录钱包.bat」。准备真实交易后，再双击「双击启动交易.bat」。
echo TG 群和热门网址发现需要另外双击 tg_login.bat 完成你自己的 TG 登录。
pause
