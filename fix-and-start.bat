@echo off
chcp 65001 >nul 2>&1
echo ============================================
echo   Lumora Fix & Start
echo ============================================
echo.

REM 自动切换到本脚本所在目录（无论从哪里双击/运行）
cd /d "%~dp0"
if errorlevel 1 (
    echo [ERROR] Cannot enter script directory: %~dp0
    pause
    exit /b 1
)

echo Current directory: %CD%
echo.

echo [1/4] Killing leftover Electron processes...
taskkill /F /IM electron.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo [2/4] Running fix script...
node fix-addhistory.js
if errorlevel 1 (
    echo.
    echo [ERROR] Fix script failed! Check errors above.
    pause
    exit /b 1
)

echo.
echo [3/4] Clearing Electron cache...
if exist "%APPDATA%\electron\Code Cache\js" (
  rd /s /q "%APPDATA%\electron\Code Cache\js" >nul 2>&1
  echo       JS Code Cache cleared
)
if exist "%APPDATA%\electron\Cache" (
  rd /s /q "%APPDATA%\electron\Cache" >nul 2>&1
  echo       Electron HTTP Cache cleared
)
if exist "%LOCALAPPDATA%\Lumora\Cache" (
  rd /s /q "%LOCALAPPDATA%\Lumora\Cache" >nul 2>&1
  echo       Lumora HTTP Cache cleared
)

echo.
echo [4/4] Starting Lumora...
echo.
call npm start

pause
