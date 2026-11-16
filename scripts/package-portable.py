"""Prepare a self-contained Windows distribution; no install step on the recipient PC."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
STAGE = ROOT / 'runtime/portable-build/Krugi'
IGNORE = shutil.ignore_patterns('__pycache__', '*.pyc', '*.pyo', '.git', '.DS_Store')


def copy(relative, destination=None):
    source = ROOT / relative
    vendor_files = {
        'tools/llama-cpp/LICENSE': 'packaging/licenses/llama.cpp-LICENSE',
        'tools/llama-cpp/Qwen-LICENSE': 'packaging/licenses/Qwen-LICENSE',
        'tools/llama-cpp/assets-manifest.json': 'packaging/assets-manifest.json',
    }
    if not source.exists() and str(relative) in vendor_files:
        source = ROOT / vendor_files[str(relative)]
    if not source.exists():
        raise FileNotFoundError('Portable build input is missing: ' + str(relative))
    target = STAGE / (destination or relative)
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(source, target, ignore=IGNORE, dirs_exist_ok=True)
    else:
        shutil.copy2(source, target)


def sha(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def files():
    for path in sorted(STAGE.rglob('*')):
        relative = path.relative_to(STAGE)
        if relative.parts[0] == 'runtime' or '__pycache__' in relative.parts:
            continue
        if path.is_symlink() or path.is_junction():
            raise RuntimeError('Non-portable link: ' + str(relative))
        if path.is_file() and path.suffix not in ('.pyc', '.pyo'):
            yield path, relative


def prepare():
    STAGE.mkdir(parents=True, exist_ok=True)
    print('Copying app and local models...', flush=True)
    for relative in ['dist/server.cjs', 'apps/frontend/dist', 'data', 'skills', 'package.json', 'bun.lock',
                     'apps/frontend/package.json', 'apps/backend/package.json', 'packages/shared/package.json',
                     'scripts/start.ps1', 'scripts/stop.ps1', 'scripts/launch.ps1', 'scripts/serve-frontend.cjs',
                     'scripts/portable-smoke.cjs', 'ЗАПУСК.cmd', 'ЗАПУСК НА ПРОЦЕССОРЕ.cmd', 'ОСТАНОВИТЬ.cmd',
                     'start.ps1', 'stop.ps1', 'tools/node/node.exe', 'tools/piper',
                     'tools/llama-cpp/bin', 'tools/llama-cpp/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
                     'tools/llama-cpp/LICENSE', 'tools/llama-cpp/Qwen-LICENSE', 'tools/llama-cpp/assets-manifest.json',
                     'tools/vosk/vosk-model-small-ru-0.22', 'tools/moss-tts/ort_cpu_runtime.py', 'tools/moss-tts/LICENSE']:
        copy(relative)
    for source in (ROOT / 'apps/voice').glob('*.py'):
        if not source.name.startswith('test_') and not source.name.endswith('_smoke.py'):
            copy(source.relative_to(ROOT))
    for relative in ['runtime/reports/krugi-agent-analysis.html', 'runtime/reports/krugi-agent-analysis.md']:
        source = relative if (ROOT / relative).exists() else 'docs/' + Path(relative).name
        copy(source, 'docs/' + Path(relative).name)
    fixture = 'runtime/piper-fixtures/visitor-prices-16k.wav'
    copy(fixture if (ROOT / fixture).exists() else 'tests/fixtures/visitor-prices-16k.wav', 'scripts/visitor-prices.wav')
    print('Copying relocatable Python (no venv or absolute home)...', flush=True)
    python_base = ROOT / 'tools/python/interpreters/cpython-3.12.13-windows-x86_64-none'
    python_target = STAGE / 'tools/python/runtime'
    shutil.copytree(python_base, python_target, ignore=IGNORE, dirs_exist_ok=True)
    shutil.copytree(ROOT / 'tools/python/venv/Lib/site-packages', python_target / 'Lib/site-packages', ignore=IGNORE, dirs_exist_ok=True)
    # Venv-specific startup hooks are unnecessary in the standalone interpreter.
    for name in ['_virtualenv.pth', '_virtualenv.py']:
        (python_target / 'Lib/site-packages' / name).unlink(missing_ok=True)
    assert not (python_target / 'pyvenv.cfg').exists()
    # App-local Microsoft C++ runtime, not installation or modification of Windows.
    runtime_names = ['msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'msvcp140_atomic_wait.dll',
                     'msvcp140_codecvt_ids.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'concrt140.dll']
    provenance = []
    for name in runtime_names:
        source = Path(os.environ['SystemRoot']) / 'System32' / name
        if not source.exists():
            if name in ['msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']:
                raise RuntimeError('Build machine lacks C++ runtime ' + name)
            continue
        for target in [python_target / name, STAGE / 'tools/llama-cpp/bin' / name]:
            shutil.copy2(source, target)
        provenance.append({'file': name, 'sha256': sha(source), 'source': 'Microsoft Visual C++ runtime, Windows System32'})
    (STAGE / 'tools/cpp-runtime-provenance.json').write_text(json.dumps(provenance, indent=2), encoding='utf-8')
    node_license = ROOT / 'tools/node/LICENSE'
    if not node_license.exists():
        request = urllib.request.Request('https://raw.githubusercontent.com/nodejs/node/v22.22.2/LICENSE', headers={'User-Agent': 'Krugi-portable-build'})
        node_license.write_bytes(urllib.request.urlopen(request, timeout=30).read())
    copy('tools/node/LICENSE')
    print('Preparing exact production Node dependencies...', flush=True)
    env = {**os.environ, 'BUN_INSTALL_CACHE_DIR': str(ROOT / 'runtime/cache/bun'), 'TEMP': str(ROOT / 'runtime/temp'), 'TMP': str(ROOT / 'runtime/temp')}
    subprocess.run([str(ROOT / 'tools/bun/bun.exe'), 'install', '--production', '--frozen-lockfile', '--ignore-scripts', '--linker=hoisted', '--backend=copyfile'], cwd=STAGE, env=env, check=True)
    # Workspaces are already compiled into server.cjs and the frontend. Their junctions
    # point back into the app tree and are not needed by the runtime.
    workspaces = STAGE / 'node_modules/@krugi'
    if workspaces.exists():
        for entry in workspaces.iterdir():
            if entry.is_junction():
                os.rmdir(entry)
            elif entry.is_symlink():
                entry.unlink()
        if not list(workspaces.iterdir()):
            workspaces.rmdir()
    (STAGE / 'ПРОЧИТАЙТЕ.txt').write_text(
        'КРУГИ — переносимый голосовой прототип для Windows x64\n\n'
        '1. Распакуйте ВЕСЬ архив в обычную локальную папку. Не запускайте файлы внутри ZIP.\n'
        '2. Дважды нажмите ЗАПУСК.cmd. Дождитесь загрузки моделей; откроется Edge\n'
        '   (или браузер по умолчанию, если Edge не установлен).\n'
        '3. Нажмите «Начать разговор» и разрешите микрофон. Для устойчивости — наушники.\n'
        '4. После работы нажмите ОСТАНОВИТЬ.cmd: закрытие вкладки серверы не останавливает.\n\n'
        'Ничего устанавливать и скачивать не требуется. API-ключей нет.\n'
        'Node.js, Python, зависимости и модели уже включены. Права администратора\n'
        'и изменение глобальных настроек не нужны. Не запускайте из защищённой папки Program Files.\n'
        'Рекомендуется 16 ГБ RAM и современный 64-разрядный процессор.\n'
        'При доступном Vulkan используется видеокарта; при сбое — процессор.\n'
        'Можно явно выбрать ЗАПУСК НА ПРОЦЕССОРЕ.cmd. На CPU свободные ответы медленнее.\n'
        'Если адрес не открылся: http://127.0.0.1:9150/\n'
        'Для ошибки запуска окно остаётся открытым; журналы — runtime\\logs.\n'
        'Порты 9150, 3150, 8150 должны быть свободны. Одна копия за раз.\n\n'
        'Это демонстрация: база и бонусы вымышленные, CRM/запись/платежи не подключены.\n'
        'Vosk может неверно разобрать речь и цифры; телефон можно ввести текстом.\n'
        'Аналитика и 49 проверенных диалогов — docs\\krugi-agent-analysis.html.\n'
        'См. THIRD-PARTY.txt и карточки/лицензии компонентов в tools.\n', encoding='utf-8-sig')
    (STAGE / 'THIRD-PARTY.txt').write_text(
        'Third-party components and original license files are included.\n'
        'Qwen3-4B-Instruct-2507 GGUF: tools/llama-cpp/Qwen-LICENSE, assets-manifest.json.\n'
        'llama.cpp b12438: tools/llama-cpp/LICENSE. Node 22.22.2: tools/node/LICENSE.\n'
        'CPython 3.12.13: tools/python/runtime/LICENSE.txt. Python package licenses: Lib/site-packages/*.dist-info.\n'
        'Piper 1.8.0: tools/piper/Piper-COPYING; Irina: tools/piper/MODEL_CARD.\n'
        'The Irina card reports Dataset License: Unknown; commercial redistribution rights have not been verified.\n'
        'Vosk 0.3.45 and RU small 0.22: package metadata and tools/vosk model README.\n'
        'Microsoft C++ runtime DLLs: tools/cpp-runtime-provenance.json. Original redistribution terms apply:\n'
        'https://learn.microsoft.com/cpp/windows/redistributing-visual-cpp-files\n'
        'No files from user profiles, credentials, real client data, conversation logs or caches are included.\n', encoding='utf-8')
    print('Standalone imports and path check...', flush=True)
    subprocess.run([str(python_target / 'python.exe'), '-E', '-s', '-X', 'utf8', '-c',
                    'import sys,numpy,onnxruntime,vosk,piper,sentencepiece; from pathlib import Path; '
                    'assert Path(sys.base_prefix).resolve()==Path(sys.executable).resolve().parent; '
                    'print("Portable Python imports OK")'], cwd=STAGE, check=True)
    manifest()


def manifest():
    records = [{'path': str(relative).replace('\\', '/'), 'bytes': path.stat().st_size, 'sha256': sha(path)}
               for path, relative in files() if relative.name != 'portable-manifest.json']
    (STAGE / 'portable-manifest.json').write_text(json.dumps({'format': 1, 'platform': 'Windows x64', 'files': records}, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'stage': str(STAGE), 'files': len(records), 'bytes': sum(f['bytes'] for f in records)}, ensure_ascii=True), flush=True)


def archive(output):
    manifest()
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix('.zip.partial')
    with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as bundle:
        for path, relative in files():
            bundle.write(path, 'Krugi/' + str(relative).replace('\\', '/'))
    with zipfile.ZipFile(temporary) as bundle:
        bad = bundle.testzip()
        if bad:
            raise RuntimeError('Archive CRC failed: ' + bad)
    temporary.replace(output)
    digest = sha(output)
    output.with_suffix('.zip.sha256').write_text(digest + '  ' + output.name + '\n', encoding='ascii')
    print(json.dumps({'archive': str(output), 'bytes': output.stat().st_size, 'sha256': digest}, ensure_ascii=True), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--archive-only', action='store_true')
    parser.add_argument('--stage', type=Path)
    args = parser.parse_args()
    if args.stage:
        STAGE = args.stage.resolve()
    if not args.archive_only:
        prepare()
    if args.archive:
        archive(args.archive)
