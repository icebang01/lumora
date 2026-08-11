@echo off
chcp 65001 >nul 2>&1
echo ============================================
echo   Lumora 一键修复：删除 addHistory 错误
echo ============================================
echo.

cd /d "%~dp0"
if errorlevel 1 (
    echo [ERROR] 无法进入项目目录: %~dp0
    pause
    exit /b 1
)

echo [1/4] 杀死残留 Electron 进程...
taskkill /F /IM electron.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo [2/4] 运行修复脚本...
node fix-addhistory.js
if errorlevel 1 (
    echo.
    echo [ERROR] 修复脚本执行失败！检查上方错误信息。
    pause
    exit /b 1
)

echo.
echo [3/4] 清除 Electron 缓存...
if exist "%APPDATA%\electron\Code Cache\js" (
  rd /s /q "%APPDATA%\electron\Code Cache\js" >nul 2>&1
  echo       JS Code Cache 已清除
)
if exist "%APPDATA%\electron\Cache" (
  rd /s /q "%APPDATA%\electron\Cache" >nul 2>&1
  echo       Electron HTTP 缓存已清除
)
if exist "%LOCALAPPDATA%\Lumora\Cache" (
  rd /s /q "%LOCALAPPDATA%\Lumora\Cache" >nul 2>&1
  echo       Lumora HTTP 缓存已清除
)

echo.
echo [4/4] 启动 Lumora...
echo.
call npm start

pause
