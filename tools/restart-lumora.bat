@echo off
chcp 65001 >nul
echo [1/3] 正在结束 Lumora 所有进程...
taskkill /F /IM Lumora.exe /IM Lumora.exe /IM "Lumora.exe" 2>nul
timeout /t 2 /nobreak >nul

echo [2/3] 正在清理 Electron 本地缓存...
set "CACHE=%LOCALAPPDATA%\Lumora\Cache"
if exist "%CACHE%" rmdir /S /Q "%CACHE%"
set "CODE_CACHE=%LOCALAPPDATA%\Lumora\Code Cache"
if exist "%CODE_CACHE%" rmdir /S /Q "%CODE_CACHE%"
set "GPU_CACHE=%LOCALAPPDATA%\Lumora\GPUCache"
if exist "%GPU_CACHE%" rmdir /S /Q "%GPU_CACHE%"

echo [3/3] 正在启动 Lumora...
start "" "D:\IDEA\videos\dist\Lumora\Lumora.exe"
echo 完成。
