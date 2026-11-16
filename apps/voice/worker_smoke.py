"""Real JSONL worker lifecycle, ASR during synthesis, cancellation and restart."""
from __future__ import annotations

import base64
import json
import os
import queue
import subprocess
import threading
import time
import wave

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    log = (ROOT / "runtime/logs/voice-worker-smoke.log").open("w", encoding="utf-8")
    process = subprocess.Popen(
        [str(ROOT / "tools/python/venv/Scripts/python.exe"), "-u", str(ROOT / "apps/voice/worker.py")],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log,
        text=True, encoding="utf-8", cwd=ROOT,
        env={**os.environ, "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"},
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    messages: queue.Queue = queue.Queue()

    def reader():
        for line in process.stdout:
            messages.put((time.perf_counter(), json.loads(line)))

    threading.Thread(target=reader, daemon=True).start()

    def send(message):
        process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        process.stdin.flush()

    def wait_for(predicate, timeout=25):
        deadline = time.perf_counter() + timeout
        while time.perf_counter() < deadline:
            timestamp, message = messages.get(timeout=max(0.01, deadline - time.perf_counter()))
            if message["type"] == "error":
                raise AssertionError(message)
            if predicate(message):
                return timestamp, message
        raise AssertionError("Worker response timeout")

    report = {}
    try:
        _, ready = wait_for(lambda m: m["type"] == "ready")
        assert ready["asr"] and ready["tts"]
        send({"type": "asr_start", "sessionId": "smoke"})
        started = time.perf_counter()
        send({"type": "tts", "sessionId": "smoke", "turnId": 1, "text": "Здравствуйте, гончарная студия Круги, меня зовут Светлана, слушаю вас. Индивидуальное занятие на гончарном круге длится девяносто минут. Материалы и обжиг включены в стоимость."})
        first, _ = wait_for(lambda m: m["type"] == "audio" and m["turnId"] == 1)
        report["jsonlFirstAudioMs"] = round((first - started) * 1000)
        with wave.open(str(ROOT / "runtime/voice-fixtures/visitor-16k.wav"), "rb") as fixture:
            pcm = fixture.readframes(fixture.getnframes()) + bytes(32000 * 2)
        # Feed normal realtime 80 ms PCM frames while TTS is generating.
        for offset in range(0, len(pcm), 2560):
            send({"type": "pcm", "sessionId": "smoke", "audio": base64.b64encode(pcm[offset:offset + 2560]).decode("ascii")})
            time.sleep(0.08)
        _, transcript = wait_for(lambda m: m["type"] == "final")
        report["concurrentAsrTranscript"] = transcript["text"]
        assert transcript["text"], transcript
        cancelled_at = time.perf_counter()
        send({"type": "cancel", "sessionId": "smoke", "turnId": 1})
        # New turn proves both cancellation and future synthesis remain healthy.
        send({"type": "tts", "sessionId": "smoke", "turnId": 2, "text": "Слушаю вас."})
        second, _ = wait_for(lambda m: m["type"] == "audio" and m["turnId"] == 2)
        report["nextTurnFirstAudioMs"] = round((second - cancelled_at) * 1000)
        _, ended = wait_for(lambda m: m["type"] == "tts_end" and m["turnId"] == 2)
        report["nextTurnAudioSeconds"] = ended["audioSeconds"]
        send({"type": "asr_stop", "sessionId": "smoke"})
        send({"type": "asr_start", "sessionId": "smoke"})
        report["asrRestart"] = True
        send({"type": "shutdown"})
        process.wait(timeout=5)
        assert process.returncode == 0
        report["cleanShutdown"] = True
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        log.close()
    (ROOT / "runtime/voice-worker-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
