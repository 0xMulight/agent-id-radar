@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Agent ID Radar - 真实交易
echo 本窗口将启用真实交易。请先确认配置的钱包、日预算和项目预算。
node personal\launch.mjs --execute
pause
