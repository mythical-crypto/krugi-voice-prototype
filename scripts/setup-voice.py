"""Download pinned voice assets. All state stays beneath the project root."""
from __future__ import annotations

import concurrent.futures
import hashlib
import json
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MOSS = ROOT / "tools/moss-tts"
LOCK = MOSS / "assets-lock.json"
REVISIONS = {
    "OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX": "f52645cb467506d8e18e746ddd59482685b74e58",
    "OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX": "ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae",
}
SOURCE_REVISION = "8b7bcc9341b3b4ef3a3a58ba1338a7d85ff133eb"


def read_url(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "Krugi-local-prototype"})
    with urllib.request.urlopen(request, timeout=90) as response:
        return response.read()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download(asset: dict) -> dict:
    target = ROOT / asset["path"]
    target.parent.mkdir(parents=True, exist_ok=True)
    expected = asset.get("sha256")
    if target.is_file() and expected and sha256(target) == expected:
        return asset
    temporary = target.with_suffix(target.suffix + ".download")
    url = asset["url"] + ("?download=true" if "huggingface.co/" in asset["url"] and "?" not in asset["url"] else "")
    request = urllib.request.Request(url, headers={"User-Agent": "Krugi-local-prototype"})
    with urllib.request.urlopen(request, timeout=300) as source, temporary.open("wb") as output:
        while block := source.read(4 * 1024 * 1024):
            output.write(block)
    actual = sha256(temporary)
    if expected and actual != expected:
        raise RuntimeError(f"SHA256 mismatch: {asset['path']}")
    temporary.replace(target)
    print(f"Ready {asset['path']} ({target.stat().st_size} bytes)", flush=True)
    return {**asset, "sha256": actual, "size": target.stat().st_size}


def discover_assets() -> list[dict]:
    assets = []
    for repo, revision in REVISIONS.items():
        files = json.loads(read_url(f"https://huggingface.co/api/models/{repo}/tree/{revision}?recursive=true"))
        directory = repo.split("/")[1]
        for item in files:
            name = item["path"]
            if item["type"] != "file" or name.startswith("."):
                continue
            assets.append({
                "path": f"tools/moss-tts/{directory}/{name}",
                "url": f"https://huggingface.co/{repo}/resolve/{revision}/{name}",
                "sha256": (item.get("lfs") or {}).get("oid"),
            })
    for name, relative in [("ort_cpu_runtime.py", "ort_cpu_runtime.py"), ("LICENSE", "LICENSE"), ("assets/audio/en_3.wav", "voices/en_3.wav")]:
        assets.append({"path": f"tools/moss-tts/{relative}", "url": f"https://raw.githubusercontent.com/OpenMOSS/MOSS-TTS-Nano/{SOURCE_REVISION}/{name}"})
    assets.append({"path": "tools/vosk/vosk-model-small-ru-0.22.zip", "url": "https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip"})
    return assets


def main() -> None:
    assets = json.loads(LOCK.read_text(encoding="utf-8"))["assets"] if LOCK.exists() else discover_assets()
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        downloaded = list(executor.map(download, assets))
    LOCK.write_text(json.dumps({"sourceRevision": SOURCE_REVISION, "modelRevisions": REVISIONS, "assets": downloaded}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    vosk_directory = ROOT / "tools/vosk/vosk-model-small-ru-0.22"
    if not (vosk_directory / "am/final.mdl").is_file():
        with zipfile.ZipFile(ROOT / "tools/vosk/vosk-model-small-ru-0.22.zip") as archive:
            destination = (ROOT / "tools/vosk").resolve()
            for member in archive.infolist():
                if not (destination / member.filename).resolve().is_relative_to(destination):
                    raise RuntimeError("Unsafe archive path")
            archive.extractall(destination)
    print("Voice assets ready; pinned SHA256 checks passed.", flush=True)


if __name__ == "__main__":
    main()
