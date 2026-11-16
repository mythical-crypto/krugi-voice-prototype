$ErrorActionPreference = 'Stop'
$restoreLock = $null
function Get-ArchiveHash([string]$Path) {
    $source = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($source)).Replace('-','').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $source.Dispose() }
}
try {
    if (!$manifest -or !$env:KRUGI_RELEASE_DIR) { throw 'Скачайте и запустите START-Krugi.cmd вместе с двумя частями сборки.' }
    $base = [IO.Path]::GetFullPath($env:KRUGI_RELEASE_DIR)
    $restoreLock = [IO.File]::Open((Join-Path $base '.krugi-restore.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    foreach ($part in $manifest.parts) {
        $path = Join-Path $base $part.name
        if (!(Test-Path -LiteralPath $path)) { throw "Скачайте $($part.name) в ту же папку, где находится START-Krugi.cmd." }
        Write-Host "Проверяю $($part.name)..."
        if ((Get-Item -LiteralPath $path).Length -ne $part.bytes -or (Get-ArchiveHash $path) -ne $part.sha256) { throw "Файл $($part.name) повреждён или скачан не полностью. Скачайте его заново." }
    }
    $archive = Join-Path $base $manifest.archive.name
    if (Test-Path -LiteralPath $archive) {
        if ((Get-ArchiveHash $archive) -ne $manifest.archive.sha256) { throw 'В этой папке уже есть другой ZIP с тем же именем. Выберите отдельную папку для сборки.' }
    } else {
        Write-Host 'Собираю единый ZIP...'
        $temporary = $archive + '.assembling'
        $stream = [IO.File]::Open($temporary,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try {
            foreach ($part in $manifest.parts) {
                $inputStream = [IO.File]::OpenRead((Join-Path $base $part.name))
                try { $inputStream.CopyTo($stream,1048576) } finally { $inputStream.Dispose() }
            }
        } finally { $stream.Dispose() }
        if ((Get-ArchiveHash $temporary) -ne $manifest.archive.sha256) { throw 'Контрольная сумма собранного архива не совпала.' }
        Move-Item -LiteralPath $temporary -Destination $archive
    }
    $target = Join-Path $base ('Krugi-' + $manifest.version)
    $ownerMarker = Join-Path $target '.krugi-archive.sha256'
    $completeMarker = Join-Path $target '.krugi-ready'
    if (Test-Path -LiteralPath $target) {
        if (!(Test-Path -LiteralPath $ownerMarker) -or (Get-Content -LiteralPath $ownerMarker -Raw).Trim() -ne $manifest.archive.sha256) { throw "Папка $target уже существует и не относится к этому архиву. Переместите три скачанных файла в другую папку." }
    } else {
        New-Item -ItemType Directory -Path $target | Out-Null
        $manifest.archive.sha256 | Set-Content -LiteralPath $ownerMarker -Encoding ASCII
    }
    if (!(Test-Path -LiteralPath $completeMarker)) {
        Write-Host 'Распаковываю сборку. Модель большая, это может занять несколько минут...'
        Expand-Archive -LiteralPath $archive -DestinationPath $target -Force
        'ready' | Set-Content -LiteralPath $completeMarker -Encoding ASCII
    }
    $launcher = Join-Path $target 'Krugi/ЗАПУСК.cmd'
    if (!(Test-Path -LiteralPath $launcher)) { throw 'Не найден файл запуска. Распаковка не завершена.' }
    Write-Host ('Готово: ' + (Split-Path -Parent $launcher))
    if ($env:KRUGI_RELEASE_NO_LAUNCH -ne '1') {
        & $launcher
        if ($LASTEXITCODE -ne 0) { throw 'Приложение не запустилось. Посмотрите сообщение выше и папку runtime\logs внутри Krugi.' }
    }
} catch {
    Write-Host ('Ошибка: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally {
    if ($restoreLock) { $restoreLock.Dispose() }
}
