param([switch]$Cpu,[switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
try {
    & (Join-Path $PSScriptRoot 'start.ps1') -Cpu:$Cpu
    if (!$NoBrowser) {
        $edge = @(
            (Join-Path ${env:ProgramFiles(x86)} 'Microsoft/Edge/Application/msedge.exe'),
            (Join-Path $env:ProgramFiles 'Microsoft/Edge/Application/msedge.exe'),
            (Join-Path $env:LOCALAPPDATA 'Microsoft/Edge/Application/msedge.exe')
        ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        try {
            if ($edge) { Start-Process -FilePath $edge -ArgumentList 'http://127.0.0.1:9150/' -WindowStyle Normal }
            else { Start-Process 'http://127.0.0.1:9150/' }
        } catch { Write-Host 'Сервер работает. Откройте в браузере http://127.0.0.1:9150/' }
    }
} catch {
    Write-Host ''
    Write-Host ('Не удалось запустить Круги: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'Логи находятся в папке runtime\logs. Если мешает видеокарта, используйте ЗАПУСК НА ПРОЦЕССОРЕ.cmd.'
    if (!$NoBrowser) { Read-Host 'Нажмите Enter, чтобы закрыть окно' | Out-Null }
    exit 1
}
