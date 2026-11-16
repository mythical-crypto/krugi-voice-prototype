"""Russian Piper ONNX synthesis; the existing MOSS adapter remains available."""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

import onnxruntime as ort
from piper import PiperVoice, SynthesisConfig
from piper.config import PiperConfig
from piper.phonemize_espeak import ESPEAK_DATA_DIR

from speech import ROOT, SynthesisCancelled, prepare_text


class SpeechSynthesizer:
    def __init__(self, threads: int = 3) -> None:
        directory = ROOT / "tools/piper"
        model = directory / "ru_RU-irina-medium.onnx"
        config = PiperConfig.from_dict(json.loads((directory / "ru_RU-irina-medium.onnx.json").read_text(encoding="utf-8")))
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        self.voice = PiperVoice(config=config, session=ort.InferenceSession(str(model), sess_options=options, providers=["CPUExecutionProvider"]), download_dir=ROOT / "runtime/cache/piper", espeak_data_dir=Path(os.path.relpath(ESPEAK_DATA_DIR, Path.cwd())))
        self.sample_rate = config.sample_rate
        self.config = SynthesisConfig(length_scale=0.92, noise_scale=0.45, noise_w_scale=0.6, volume=0.9)
        list(self.voice.synthesize("Здравствуйте.", syn_config=self.config))

    def synthesize(self, text, on_audio, cancelled=lambda: False):
        start = time.perf_counter()
        first = None
        samples = 0
        # Short clauses bound the time before the first spoken content and the cancel check.
        clauses = re.split(r"(?<=[.!?;])\s+|(?<=,)\s+(?=.{70,})", prepare_text(text))
        for clause in clauses:
            if not clause.strip():
                continue
            if cancelled():
                raise SynthesisCancelled()
            for chunk in self.voice.synthesize(clause, syn_config=self.config):
                pcm = chunk.audio_int16_bytes
                packet_bytes = int(chunk.sample_rate * 0.08) * 2
                for offset in range(0, len(pcm), packet_bytes):
                    if cancelled():
                        raise SynthesisCancelled()
                    if first is None:
                        first = time.perf_counter()
                    packet = pcm[offset:offset+packet_bytes]
                    on_audio(packet, chunk.sample_rate)
                    samples += len(packet)//2
        duration = time.perf_counter()-start
        return {"durationMs":round(duration*1000),"audioSeconds":round(samples/self.sample_rate,3),"firstAudioMs":round((first-start)*1000) if first else None,"engine":"piper-ru-irina"}
