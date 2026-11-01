@echo off
cd /d "%~dp0"
set RADAR_MODE=
if "%~1"=="--execute" set RADAR_MODE=--execute
if not "%~1"=="" if not "%~1"=="--execute" exit /b 1
if not exist data mkdir data
:loop
if exist WATCH_STOP exit /b 0
node personal\launch.mjs %RADAR_MODE% >> data\watch_console.log 2>&1
if errorlevel 1 exit /b 1
if exist WATCH_STOP exit /b 0
timeout /t 5 /nobreak >nul
goto loop
