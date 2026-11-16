param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$statePath = Join-Path $root 'runtime/processes.json'
if (!(Test-Path -LiteralPath $statePath)) { if (!$Quiet) { Write-Host 'Собственных процессов нет.' }; return }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$records = @($state.processes)
$unverified = @()
foreach ($record in $records) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)" -ErrorAction SilentlyContinue
    if (!$process) { continue }
    $createdTicks = $process.CreationDate.ToUniversalTime().Ticks
    if ($createdTicks -ne ([datetime]$record.created).ToUniversalTime().Ticks -or $process.ExecutablePath -ne $record.executable -or $process.CommandLine -ne $record.commandLine -or !$process.ExecutablePath.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
        Write-Warning "Не остановлен неподтвержденный PID $($record.pid)."
        $unverified += $record
        continue
    }
    # Only descendants whose executable is inside this project are eligible.
    $descendants = New-Object System.Collections.Generic.List[object]
    $queue = New-Object System.Collections.Generic.Queue[object]
    $queue.Enqueue($process)
    while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($parent.ProcessId)" -ErrorAction SilentlyContinue)
        foreach ($child in $children) {
            if ($child.CreationDate -ge $process.CreationDate -and $child.ExecutablePath -and $child.ExecutablePath.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { $descendants.Add($child); $queue.Enqueue($child) }
        }
    }
    for ($i=$descendants.Count-1; $i -ge 0; $i--) {
        $child = $descendants[$i]
        $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($child.ProcessId)" -ErrorAction SilentlyContinue
        if ($current -and $current.CreationDate -eq $child.CreationDate -and $current.ExecutablePath -eq $child.ExecutablePath) { Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)" -ErrorAction SilentlyContinue
    if ($current -and $current.CreationDate.ToUniversalTime().Ticks -eq ([datetime]$record.created).ToUniversalTime().Ticks -and $current.CommandLine -eq $record.commandLine) { Stop-Process -Id $record.pid -Force -ErrorAction SilentlyContinue }
    Wait-Process -Id $record.pid -Timeout 15 -ErrorAction SilentlyContinue
    $remaining = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)" -ErrorAction SilentlyContinue
    $liveProcess = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
    if ($liveProcess -and !$liveProcess.HasExited -and $remaining -and $remaining.CreationDate.ToUniversalTime().ToString('o') -eq $record.created) { Write-Warning "PID $($record.pid) не завершился; запись сохранена."; $unverified += $record }
}
if ($unverified.Count) { @{root=$root;processes=$unverified} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statePath -Encoding utf8 } else { Remove-Item -LiteralPath $statePath -Force }
if (!$Quiet) {
    if ($unverified.Count) { Write-Host 'Некоторые процессы ещё не завершились или не подтверждены. Их записи сохранены.' }
    else { Write-Host 'Подтвержденные процессы прототипа остановлены.' }
}
