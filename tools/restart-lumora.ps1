#Requires -Version 5.1
Write-Host '[1/3] 正在结束 Lumora 所有进程...' -ForegroundColor Cyan
Get-Process | Where-Object { $_.ProcessName -like '*Lumora*' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host '[2/3] 正在清理 Electron 本地缓存...' -ForegroundColor Cyan
$dirs = @(
    "$env:LOCALAPPDATA\Lumora\Cache",
    "$env:LOCALAPPDATA\Lumora\Code Cache",
    "$env:LOCALAPPDATA\Lumora\GPUCache"
)
foreach ($d in $dirs) {
    if (Test-Path $d) {
        Remove-Item -Path $d -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host '[3/3] 正在启动 Lumora...' -ForegroundColor Cyan
$exe = 'D:\IDEA\videos\dist\Lumora\Lumora.exe'
if (Test-Path $exe) {
    Start-Process $exe
    Write-Host '完成。' -ForegroundColor Green
} else {
    Write-Host "未找到 $exe，请手动启动。" -ForegroundColor Red
}
