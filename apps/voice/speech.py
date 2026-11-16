"""Torch-free streaming adapter for the pinned official MOSS CPU runtime."""
from __future__ import annotations

import re
import sys
import time
from pathlib import Path
from typing import Callable

import numpy as np
import sentencepiece as spm

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools/moss-tts"))
from ort_cpu_runtime import OrtCpuRuntime  # noqa: E402

ONES = ("ноль", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять")
TEENS = ("десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать")
TENS = ("", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто")
HUNDREDS = ("", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот")


def cardinal(value: int, feminine: bool = False) -> str:
    if value < 0:
        return "минус " + cardinal(-value)
    if value >= 1000000:
        return " ".join(ONES[int(c)] for c in str(value))
    if value >= 1000:
        thousands, rest = divmod(value, 1000)
        ending = "тысяч" if 11 <= thousands % 100 <= 14 else ("тысяча" if thousands % 10 == 1 else "тысячи" if 2 <= thousands % 10 <= 4 else "тысяч")
        return cardinal(thousands, True) + " " + ending + (" " + cardinal(rest) if rest else "")
    if value == 0:
        return ONES[0]
    words = []
    hundred, rest = divmod(value, 100)
    if hundred:
        words.append(HUNDREDS[hundred])
    if 10 <= rest < 20:
        words.append(TEENS[rest - 10])
    else:
        ten, one = divmod(rest, 10)
        if ten:
            words.append(TENS[ten])
        if one:
            words.append("одна" if feminine and one == 1 else "две" if feminine and one == 2 else ONES[one])
    return " ".join(words)


def prepare_text(text: str) -> str:
    # Phone numbers are spoken digit by digit; no inference of missing digits.
    phone_pattern = r"(?<!\d)(?:\+7|8)[\s()\-]*(?:\d[\s()\-]*){9}\d(?!\d)"
    text = re.sub(phone_pattern, lambda m: " ".join(ONES[int(c)] for c in m.group() if c.isdigit()), text)
    text = re.sub(r"(\d{1,3}(?:[ \u00a0]\d{3})+)", lambda m: m.group().replace(" ", "").replace("\u00a0", ""), text)
    text = re.sub(r"\d+", lambda m: cardinal(int(m.group())), text)
    return text.replace("₽", " рублей").replace("%", " процентов").replace("**", "").replace("#", "").strip()


class SynthesisCancelled(Exception):
    pass


class SpeechSynthesizer:
    def __init__(self, threads: int = 3) -> None:
        self.model_directory = ROOT / "tools/moss-tts/MOSS-TTS-Nano-100M-ONNX"
        self.runtime = OrtCpuRuntime(self.model_directory, thread_count=threads, max_new_frames=375, sample_mode="fixed")
        self.tokenizer = spm.SentencePieceProcessor(model_file=str(self.model_directory / "tokenizer.model"))
        self.voice = next(voice for voice in self.runtime.list_builtin_voices() if voice["voice"] == "Bella")
        self.sample_rate = int(self.runtime.codec_meta["codec_config"]["sample_rate"])
        self.runtime.warmup()

    def chunks(self, text: str) -> list[str]:
        words = prepare_text(text).split()
        chunks, current = [], ""
        for word in words:
            candidate = (current + " " + word).strip()
            if current and len(self.tokenizer.encode(candidate)) > 65:
                chunks.append(current)
                current = word
            else:
                current = candidate
            if re.search(r"[.!?;]$", current):
                chunks.append(current)
                current = ""
        if current:
            chunks.append(current)
        return chunks

    def synthesize(self, text: str, on_audio: Callable[[bytes, int], None], cancelled: Callable[[], bool] = lambda: False) -> dict:
        started = time.perf_counter()
        first_audio = None
        samples = 0
        for chunk in self.chunks(text):
            if cancelled():
                raise SynthesisCancelled()
            runtime = self.runtime
            request = runtime.build_voice_clone_request_rows(self.voice["prompt_audio_codes"], [int(token) for token in self.tokenizer.encode(chunk)])
            pending = []
            runtime.codec_streaming_session.reset()

            def flush(force: bool = False) -> None:
                nonlocal first_audio, samples
                if cancelled():
                    raise SynthesisCancelled()
                # Two codec frames make a 160 ms packet; first packet is content.
                if not pending or (not force and len(pending) < 2):
                    return
                result = runtime.codec_streaming_session.run_frames(list(pending))
                pending.clear()
                if result is None:
                    return
                audio, length = result
                if length <= 0:
                    return
                mono = audio[0, :, :length].mean(axis=0)
                pcm = (np.clip(mono, -1.0, 1.0) * 32767).astype("<i2").tobytes()
                if cancelled():
                    raise SynthesisCancelled()
                if first_audio is None:
                    first_audio = time.perf_counter()
                samples += length
                on_audio(pcm, self.sample_rate)

            def on_frame(_frames: list, _index: int, frame: list[int]) -> None:
                if cancelled():
                    raise SynthesisCancelled()
                pending.append(frame)
                flush()

            try:
                runtime.generate_audio_frames(request, on_frame=on_frame)
                flush(True)
            finally:
                runtime.codec_streaming_session.reset()
        elapsed = time.perf_counter() - started
        return {"durationMs": round(elapsed * 1000), "audioSeconds": round(samples / self.sample_rate, 3), "firstAudioMs": round((first_audio - started) * 1000) if first_audio else None}
