"""Local JSONL ASR/TTS worker. stdout is reserved for protocol messages."""
from __future__ import annotations

import base64
import binascii
import json
import os
import queue
import sys
import threading
from pathlib import Path

from vosk import KaldiRecognizer, Model, SetLogLevel

from speech import ROOT, SynthesisCancelled, prepare_text
if os.environ.get('KRUGI_TTS','piper')=='moss':
    from speech import SpeechSynthesizer
else:
    from piper_speech import SpeechSynthesizer
from recognition import StreamingRecognition

OUTPUT_LOCK = threading.Lock()
STATE_LOCK = threading.Lock()
LATEST: dict[str, int] = {}
CANCELLED: set[tuple[str, int]] = set()
ASR_QUEUE: queue.Queue = queue.Queue(maxsize=256)
TTS_QUEUE: queue.Queue = queue.Queue(maxsize=16)
SHUTDOWN = threading.Event()


def emit(message: dict) -> None:
    with OUTPUT_LOCK:
        print(json.dumps(message, ensure_ascii=False, separators=(",", ":")), flush=True)


def is_cancelled(session: str, turn: int) -> bool:
    with STATE_LOCK:
        return SHUTDOWN.is_set() or (session, turn) in CANCELLED or LATEST.get(session) != turn


def asr_loop(model: Model) -> None:
    recognizers: dict[str, StreamingRecognition] = {}
    while not SHUTDOWN.is_set():
        try:
            message = ASR_QUEUE.get(timeout=0.25)
        except queue.Empty:
            continue
        session = message["sessionId"]
        try:
            if message["type"] == "asr_start":
                if len(recognizers) >= 8 and session not in recognizers:
                    raise ValueError("Слишком много одновременных разговоров")
                recognizer = KaldiRecognizer(model, 16000)
                recognizers[session] = StreamingRecognition(recognizer)
            elif message["type"] == "asr_stop":
                recognizers.pop(session, None)
            elif message["type"] == "pcm" and session in recognizers:
                pcm = base64.b64decode(message["audio"], validate=True)
                if len(pcm) % 2 or len(pcm) > 65536:
                    raise ValueError("Некорректный звуковой фрагмент")
                partial, final = recognizers[session].accept(pcm)
                if final:
                    emit({"type":"final","sessionId":session,"text":final})
                elif partial is not None:
                    emit({"type":"partial","sessionId":session,"text":partial})
        except (ValueError, KeyError, binascii.Error) as error:
            emit({"type": "error", "sessionId": session, "message": str(error)})
        except Exception as error:
            print(f"ASR error: {error}", file=sys.stderr, flush=True)
            emit({"type": "error", "sessionId": session, "message": "Ошибка локального распознавания речи"})


def tts_loop(synthesizer: SpeechSynthesizer) -> None:
    while not SHUTDOWN.is_set():
        try:
            message = TTS_QUEUE.get(timeout=0.25)
        except queue.Empty:
            continue
        session, turn = message["sessionId"], message["turnId"]
        if is_cancelled(session, turn):
            continue
        try:
            emit({"type": "tts_text", "sessionId": session, "turnId": turn, "text": prepare_text(message["text"])})
            def send_audio(pcm: bytes, sample_rate: int) -> None:
                if not is_cancelled(session, turn):
                    emit({"type": "audio", "sessionId": session, "turnId": turn, "audio": base64.b64encode(pcm).decode("ascii"), "sampleRate": sample_rate, "channels": 1})

            metrics = synthesizer.synthesize(message["text"], send_audio, lambda: is_cancelled(session, turn))
            if not is_cancelled(session, turn):
                emit({"type": "tts_end", "sessionId": session, "turnId": turn, **metrics})
        except SynthesisCancelled:
            pass
        except Exception as error:
            print(f"TTS error: {error}", file=sys.stderr, flush=True)
            emit({"type": "error", "sessionId": session, "turnId": turn, "message": "Ошибка локального синтеза речи"})


def validate(message: object) -> dict:
    if not isinstance(message, dict) or message.get("type") not in {"asr_start", "asr_stop", "pcm", "tts", "cancel", "shutdown"}:
        raise ValueError("Неизвестное событие голосового процесса")
    kind = message["type"]
    allowed = {
        "shutdown": {"type"},
        "asr_start": {"type", "sessionId"},
        "asr_stop": {"type", "sessionId"},
        "pcm": {"type", "sessionId", "audio"},
        "tts": {"type", "sessionId", "turnId", "text"},
        "cancel": {"type", "sessionId", "turnId"},
    }
    if set(message) != allowed[kind]:
        raise ValueError("Некорректные поля сообщения")
    if kind == "shutdown":
        return message
    session = message.get("sessionId")
    if not isinstance(session, str) or not 1 <= len(session) <= 100:
        raise ValueError("Некорректная сессия")
    if kind in {"tts", "cancel"} and (type(message.get("turnId")) is not int or not 0 <= message["turnId"] < 2147483647):
        raise ValueError("Некорректная реплика")
    if kind == "tts" and (not isinstance(message["text"], str) or not 1 <= len(message["text"].strip()) <= 4000):
        raise ValueError("Некорректный текст синтеза")
    if kind == "pcm" and (not isinstance(message["audio"], str) or len(message["audio"]) > 87384):
        raise ValueError("Некорректный звуковой фрагмент")
    if kind == "tts" and (not isinstance(message.get("text"), str) or not 1 <= len(message["text"]) <= 5000):
        raise ValueError("Некорректный текст синтеза")
    if kind == "pcm" and (not isinstance(message.get("audio"), str) or len(message["audio"]) > 90000):
        raise ValueError("Некорректный звуковой фрагмент")
    return message


def main() -> None:
    # Native Vosk on Windows cannot open an absolute UTF-8 path containing Cyrillic.
    # Keep model paths ASCII and relative to the project's Unicode-aware process cwd.
    os.chdir(ROOT)
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    SetLogLevel(-1)
    try:
        model = Model("tools/vosk/vosk-model-small-ru-0.22")
        synthesizer = SpeechSynthesizer()
    except Exception as error:
        print(f"Voice initialization failed: {error}", file=sys.stderr, flush=True)
        emit({"type": "error", "message": "Локальные голосовые модели не готовы. Выполните setup.ps1."})
        sys.exit(1)
    threads = [threading.Thread(target=asr_loop, args=(model,), daemon=True), threading.Thread(target=tts_loop, args=(synthesizer,), daemon=True)]
    for thread in threads:
        thread.start()
    emit({"type": "ready", "asr": True, "tts": True})
    try:
        for line in sys.stdin:
            try:
                if len(line) > 131072:
                    raise ValueError("Слишком большое сообщение")
                message = validate(json.loads(line))
                kind = message["type"]
                if kind == "shutdown":
                    break
                if kind == "cancel":
                    with STATE_LOCK:
                        CANCELLED.add((message["sessionId"], message["turnId"]))
                elif kind == "tts":
                    with STATE_LOCK:
                        LATEST[message["sessionId"]] = message["turnId"]
                        CANCELLED.difference_update(item for item in list(CANCELLED) if item[0] == message["sessionId"])
                    TTS_QUEUE.put_nowait(message)
                else:
                    if kind == "asr_stop":
                        with STATE_LOCK:
                            LATEST.pop(message["sessionId"], None)
                            CANCELLED.difference_update(item for item in list(CANCELLED) if item[0] == message["sessionId"])
                    ASR_QUEUE.put_nowait(message)
            except (ValueError, KeyError, queue.Full) as error:
                emit({"type": "error", "message": "Некорректное сообщение или переполнена очередь голосового процесса", "detail": str(error)})
    finally:
        SHUTDOWN.set()
        for thread in threads:
            thread.join(timeout=2)


if __name__ == "__main__":
    main()
