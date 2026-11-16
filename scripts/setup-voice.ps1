$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$env:UV_PYTHON_INSTALL_DIR = Join-Path $root 'tools/python/interpreters'
$env:UV_CACHE_DIR = Join-Path $root 'runtime/cache/uv'
$env:UV_TOOL_DIR = Join-Path $root 'tools/python/uv-tools'
$env:PIP_CACHE_DIR = Join-Path $root 'runtime/cache/pip'
$env:PYTHONUTF8 = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:TEMP = Join-Path $root 'runtime/tmp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
$env:TEMP = Join-Path $root 'runtime/tmp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
$uv = Join-Path $root 'tools/python/uv.exe'
if (-not (Test-Path -LiteralPath $uv)) {
    $installed = Get-Command uv -ErrorAction SilentlyContinue
    if (-not $installed) { throw 'uv is needed for Python setup. Place uv.exe in tools/python/uv.exe.' }
    Copy-Item -LiteralPath $installed.Source -Destination $uv
}
& $uv python install 3.12.13 --no-bin --no-registry
if ($LASTEXITCODE -ne 0) { throw 'Python installation failed' }
$python = Join-Path $root 'tools/python/venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    & $uv venv --python 3.12.13 (Join-Path $root 'tools/python/venv')
    if ($LASTEXITCODE -ne 0) { throw 'Python environment creation failed' }
}
& $uv pip install --python $python -r (Join-Path $root 'apps/voice/requirements.lock.txt')
if ($LASTEXITCODE -ne 0) { throw 'Voice dependencies installation failed' }
& $python (Join-Path $PSScriptRoot 'setup-voice.py')
if ($LASTEXITCODE -ne 0) { throw 'Voice model setup failed' }
& $python (Join-Path $PSScriptRoot 'setup-piper.py')
if ($LASTEXITCODE -ne 0) { throw 'Russian Piper voice setup failed' }
