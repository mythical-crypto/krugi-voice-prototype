param([switch]$Cpu)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$statePath = Join-Path $root 'runtime/processes.json'
$node = Join-Path $root 'tools/node/node.exe'
$llama = Join-Path $root 'tools/llama-cpp/bin/llama-server.exe'
$model = Join-Path $root 'tools/llama-cpp/Qwen3-4B-Instruct-2507-Q4_K_M.gguf'
$python = Join-Path $root 'tools/python/runtime/python.exe'
if (!(Test-Path -LiteralPath $python)) { $python = Join-Path $root 'tools/python/venv/Scripts/python.exe' }
if (![Environment]::Is64BitOperatingSystem -or ![Environment]::Is64BitProcess) { throw 'Нужна 64-разрядная Windows и 64-разрядный PowerShell.' }
$required = @((Join-Path $root 'tools/piper/ru_RU-irina-medium.onnx'),(Join-Path $root 'tools/piper/ru_RU-irina-medium.onnx.json'),$node,$llama,$model,(Join-Path $root 'dist/server.cjs'),(Join-Path $root 'apps/frontend/dist/index.html'),$python,(Join-Path $root 'tools/vosk/vosk-model-small-ru-0.22/am/final.mdl'))
foreach ($file in $required) { if (!(Test-Path -LiteralPath $file)) { throw "Отсутствует $file. Распакуйте архив целиком; для исходного проекта выполните .\setup.ps1." } }
New-Item -ItemType Directory -Path (Join-Path $root 'runtime/logs') -Force | Out-Null
if (Test-Path -LiteralPath $statePath) {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $allOwned = @($state.processes).Count -eq 3 -and $state.root -eq $root
    foreach ($record in @($state.processes)) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)" -ErrorAction SilentlyContinue
        if (!$p -or $p.ExecutablePath -ne $record.executable -or $p.CommandLine -ne $record.commandLine -or $p.CreationDate.ToUniversalTime().Ticks -ne ([datetime]$record.created).ToUniversalTime().Ticks) { $allOwned = $false }
    }
    if ($allOwned) {
        try {
            $health = Invoke-RestMethod 'http://127.0.0.1:3150/api/health' -TimeoutSec 4
            if (!$health.llm -or !$health.voice) { throw 'Модели ещё не готовы' }
            Invoke-WebRequest 'http://127.0.0.1:9150' -UseBasicParsing -TimeoutSec 4 | Out-Null
            Write-Host 'Уже запущено: http://127.0.0.1:9150'
            return
        } catch { throw 'Собственные процессы уже запущены, но не готовы. Посмотрите runtime/logs или выполните .\stop.ps1.' }
    }
    & (Join-Path $PSScriptRoot 'stop.ps1') -Quiet
}
foreach ($port in @(8150,3150,9150)) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if ($listeners.Count) { throw "Порт $port занят (PID $($listeners.OwningProcess -join ', ')). Закройте другую копию Кругов. Чужой процесс не остановлен." }
}
$env:KRUGI_ROOT = $root
if (Test-Path -LiteralPath (Join-Path $root 'tools/python/runtime/python.exe')) { $env:KRUGI_TTS = 'piper' }
$env:PORT = '3150'
$env:LLM_URL = 'http://127.0.0.1:8150'
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
$env:HF_HOME = Join-Path $root 'runtime/cache/huggingface'
$env:LLAMA_CACHE = Join-Path $root 'runtime/cache/llama'
$env:XDG_CACHE_HOME = Join-Path $root 'runtime/cache'
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONUTF8 = '1'
$env:TEMP = Join-Path $root 'runtime/temp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
$owned = New-Object System.Collections.Generic.List[object]
function Start-Owned([string]$Name,[string]$Executable,[string[]]$Arguments) {
    $quoted = @($Arguments | ForEach-Object { '"' + $_.Replace('"','\"') + '"' })
    $p = Start-Process -FilePath $Executable -ArgumentList $quoted -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root "runtime/logs/$Name.out.log") -RedirectStandardError (Join-Path $root "runtime/logs/$Name.err.log") -PassThru
    Start-Sleep -Milliseconds 200
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)"
    if (!$cim) { throw "$Name завершился при запуске; смотрите runtime/logs/$Name.err.log" }
    $owned.Add(@{name=$Name;pid=$p.Id;created=$cim.CreationDate.ToUniversalTime().ToString('o');executable=$cim.ExecutablePath;commandLine=$cim.CommandLine})
    @{root=$root;processes=@($owned.ToArray())} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statePath -Encoding utf8
}
function Wait-Http([string]$Url,[int]$Seconds,[switch]$Models) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        foreach ($record in $owned) { if (!(Get-Process -Id $record.pid -ErrorAction SilentlyContinue)) { throw "$($record.name) завершился. Смотрите runtime/logs." } }
        try {
            $response = Invoke-WebRequest -Uri $Url -TimeoutSec 3 -UseBasicParsing
            if ($response.StatusCode -eq 200) {
                if (!$Models) { return }
                $ready = $response.Content | ConvertFrom-Json
                if ($ready.llm -and $ready.voice) { return }
            }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    throw "Не дождались $Url. Смотрите runtime/logs."
}
try {
    $commonArguments = @('-m',$model,'-c','8192','--jinja','--host','127.0.0.1','--port','8150','--parallel','1','--threads','6','--offline','--cors-origins','localhost')
    $gpuAvailable = $false
    if (!$Cpu) {
        try { $devices = & $llama --list-devices 2>&1 | Out-String; $gpuAvailable = $LASTEXITCODE -eq 0 -and $devices -match 'Vulkan\d+:' } catch { }
    }
    $mode = 'cpu'
    if ($gpuAvailable) {
        try {
            Write-Host 'Загрузка Qwen на видеокарте...'
            Start-Owned 'llama' $llama ($commonArguments + @('-ngl','99'))
            Wait-Http 'http://127.0.0.1:8150/health' 120
            $mode = 'vulkan'
        } catch {
            Write-Host 'Видеокарта недоступна для модели. Перехожу на процессор...'
            & (Join-Path $PSScriptRoot 'stop.ps1') -Quiet
            $owned.Clear()
            if (Get-NetTCPConnection -State Listen -LocalPort 8150 -ErrorAction SilentlyContinue) { throw 'Порт модели не освободился. Повторите запуск после остановки.' }
        }
    }
    if ($mode -eq 'cpu') {
        Write-Host 'Загрузка Qwen на процессоре. Ответы будут медленнее...'
        Start-Owned 'llama' $llama ($commonArguments + @('--device','none','-ngl','0','--no-op-offload'))
        Wait-Http 'http://127.0.0.1:8150/health' 180
    }
    @{mode=$mode;startedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'runtime/launch-mode.json') -Encoding utf8
    Start-Owned 'backend' $node @((Join-Path $root 'dist/server.cjs'))
    Wait-Http 'http://127.0.0.1:3150/api/health' 180 -Models
    Start-Owned 'frontend' $node @((Join-Path $PSScriptRoot 'serve-frontend.cjs'))
    Wait-Http 'http://127.0.0.1:9150' 20
    Write-Host 'Готово: http://127.0.0.1:9150'
    Write-Host 'Остановка: ОСТАНОВИТЬ.cmd. Логи: runtime\logs. Разрешите микрофон в браузере.'
} catch { & (Join-Path $PSScriptRoot 'stop.ps1') -Quiet; throw }
