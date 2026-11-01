@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist baw2pkg\node_modules\@binance\agentic-wallet\dist\index.js (
  call npm install @binance/agentic-wallet@1.12.0 --prefix baw2pkg --no-audit --no-fund
  if errorlevel 1 exit /b 1
)
if not exist baw2 mkdir baw2
node login.mjs 2
pause
