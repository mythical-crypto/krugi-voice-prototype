param([switch]$SkipInstall, [switch]$SkipBuild, [switch]$SkipVoice)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$env:TEMP = Join-Path $root 'runtime/temp'
$env:TMP = $env:TEMP
$env:BUN_INSTALL_CACHE_DIR = Join-Path $root 'runtime/cache/bun'
$env:npm_config_cache = Join-Path $root 'runtime/cache/npm'
$env:UV_CACHE_DIR = Join-Path $root 'runtime/cache/uv'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $root 'tools/python/interpreters'
@('runtime/temp','runtime/cache/bun','runtime/cache/npm','tools/node','tools/bun','tools/llama-cpp/downloads') | ForEach-Object { New-Item -ItemType Directory -Path (Join-Path $root $_) -Force | Out-Null }

function Get-VerifiedFile([string]$Url,[string]$Destination,[string]$Sha256) {
    if ((Test-Path -LiteralPath $Destination) -and ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -eq $Sha256)) { return }
    $partial = "$Destination.partial"
    & curl.exe -L --fail --retry 3 --retry-delay 2 --output $partial $Url
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
    if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $Sha256) { throw "SHA256 mismatch: $Destination" }
    Move-Item -LiteralPath $partial -Destination $Destination -Force
}

Get-VerifiedFile 'https://nodejs.org/dist/v22.22.2/win-x64/node.exe' (Join-Path $root 'tools/node/node.exe') 'ae1a50511be58e987483fdbc12125407443926d2d394669ade2352776e920dd3'
$bun = Join-Path $root 'tools/bun/bun.exe'
if (!(Test-Path -LiteralPath $bun) -or (Get-FileHash -LiteralPath $bun -Algorithm SHA256).Hash -ne '2897da86db2cff7bb4174e2e3ec53545126e9da622af7d23ae226846694c8bca') {
    $bunArchive = Join-Path $root 'tools/bun/bun-v1.3.3.zip'
    Get-VerifiedFile 'https://github.com/oven-sh/bun/releases/download/bun-v1.3.3/bun-windows-x64.zip' $bunArchive '53e239b058c13f0bb70949b222c4d40c5ab7d6cad22268b2ace2187fcfd7a247'
    Expand-Archive -LiteralPath $bunArchive -DestinationPath (Join-Path $root 'tools/bun/unpacked') -Force
    Copy-Item -LiteralPath (Join-Path $root 'tools/bun/unpacked/bun-windows-x64/bun.exe') -Destination $bun -Force
    if ((Get-FileHash -LiteralPath $bun -Algorithm SHA256).Hash -ne '2897da86db2cff7bb4174e2e3ec53545126e9da622af7d23ae226846694c8bca') { throw 'Unexpected Bun executable checksum' }
}
$llamaArchive = Join-Path $root 'tools/llama-cpp/downloads/llama-b12438.zip'
Get-VerifiedFile 'https://github.com/ggml-org/llama.cpp/releases/download/b12438/llama-b12438-bin-win-vulkan-x64.zip' $llamaArchive '726d07e26dcc57325bb249bf804669916b02470ab0078b2ed9741a0c48bdd04f'
if (!(Test-Path -LiteralPath (Join-Path $root 'tools/llama-cpp/bin/llama-server.exe'))) { Expand-Archive -LiteralPath $llamaArchive -DestinationPath (Join-Path $root 'tools/llama-cpp/bin') -Force }
Get-VerifiedFile 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/a06e946bb6b655725eafa393f4a9745d460374c9/Qwen3-4B-Instruct-2507-Q4_K_M.gguf' (Join-Path $root 'tools/llama-cpp/Qwen3-4B-Instruct-2507-Q4_K_M.gguf') '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597'
$env:PATH = "$(Join-Path $root 'tools/node');$(Join-Path $root 'tools/bun');$env:PATH"
if (!$SkipVoice) { & (Join-Path $PSScriptRoot 'setup-voice.ps1'); if ($LASTEXITCODE -ne 0) { throw 'Voice setup failed' } }
if (!$SkipInstall) { & $bun install --frozen-lockfile; if ($LASTEXITCODE -ne 0) { throw 'bun install failed' } }
if (!$SkipBuild) { & $bun run build; if ($LASTEXITCODE -ne 0) { throw 'Build failed' } }
Write-Host 'Готово. Запуск: .\start.ps1; проверка: .\tools\bun\bun.exe run verify'
