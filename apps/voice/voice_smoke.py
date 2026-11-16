"""Exercise actual MOSS and Vosk, save reusable PCM fixtures and measurements."""
from __future__ import annotations

import json
import sys
import time
import wave

import numpy as np
from vosk import KaldiRecognizer, Model, SetLogLevel

from speech import ROOT, SpeechSynthesizer, SynthesisCancelled, prepare_text

SAMPLES = [
    ("greeting", "Здравствуйте, гончарная студия Круги, меня зовут Светлана, слушаю вас"),
    ("wheel", "Индивидуальное занятие на гончарном круге стоит три тысячи двести рублей."),
    ("quote", "У вас шестьсот бонусов. К оплате две тысячи шестьсот рублей."),
    ("phone", "Семь девятьсот один два три четыре пять шесть семь."),
    ("visitor", "Я впервые в студии. Хочу на гончарный круг."),
]


def save_wav(path, pcm, rate):
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(pcm)


def main():
    output = ROOT / "runtime/voice-fixtures"
    output.mkdir(parents=True, exist_ok=True)
    SetLogLevel(-1)
    started = time.perf_counter()
    synthesizer = SpeechSynthesizer()
    initialization_ms = round((time.perf_counter() - started) * 1000)
    model = Model(str(ROOT / "tools/vosk/vosk-model-small-ru-0.22"))
    report = {"tts": "MOSS-TTS-Nano-100M-ONNX", "voice": "Bella (English Female, speaking Russian)", "asr": "vosk-model-small-ru-0.22", "initializationMs": initialization_ms, "samples": [], "physicalMicrophoneTested": False}
    for key, text in SAMPLES:
        audio = []
        metrics = synthesizer.synthesize(text, lambda pcm, rate: audio.append(pcm))
        pcm = b"".join(audio)
        amplitudes = np.frombuffer(pcm, dtype="<i2").astype(np.float32)
        active_samples = np.flatnonzero(np.abs(amplitudes) > 655)
        metrics["leadingSilenceMs"] = round(int(active_samples[0]) * 1000 / synthesizer.sample_rate) if len(active_samples) else None
        save_wav(output / f"{key}.wav", pcm, synthesizer.sample_rate)
        # Integer decimation is exact 48k -> 16k for generated speech.
        downsampled = np.frombuffer(pcm, dtype="<i2")[::3].tobytes()
        save_wav(output / f"{key}-16k.wav", downsampled, 16000)
        recognizer = KaldiRecognizer(model, 16000)
        recognized = []
        for start in range(0, len(downsampled), 2560):
            if recognizer.AcceptWaveform(downsampled[start:start + 2560]):
                recognized.append(json.loads(recognizer.Result()).get("text", ""))
        recognized.append(json.loads(recognizer.FinalResult()).get("text", ""))
        item = {"id": key, "text": text, "spokenText": prepare_text(text), **metrics, "realTimeFactor": round(metrics["durationMs"] / (metrics["audioSeconds"] * 1000), 3), "asrTranscript": " ".join(x for x in recognized if x)}
        report["samples"].append(item)
        print(json.dumps(item, ensure_ascii=False), flush=True)
        (ROOT / "runtime/voice-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    calls = 0
    cancelled_at = None

    def audio_then_cancel(_pcm, _rate):
        nonlocal calls, cancelled_at
        calls += 1
        cancelled_at = time.perf_counter()

    try:
        synthesizer.synthesize(SAMPLES[1][1], audio_then_cancel, lambda: calls >= 1)
    except SynthesisCancelled:
        report["cancelAfterFirstPacketMs"] = round((time.perf_counter() - cancelled_at) * 1000)
    report["torchImported"] = "torch" in sys.modules
    (ROOT / "runtime/voice-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
