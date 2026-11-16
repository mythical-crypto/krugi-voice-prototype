"""Short, audio-time endpoint with a longer pause budget for digit dictation."""
from array import array
import math
import re

DIGITS = set("ноль нуль один одна два две три четыре пять шесть семь восемь девять плюс".split())


class SpeechEndpoint:
    def __init__(self):
        self.reset()

    def reset(self):
        self.heard_speech = False
        self.silent_samples = 0

    def observe(self, pcm: bytes, partial: str) -> bool:
        samples = array("h", pcm)
        if not samples:
            return False
        rms = math.sqrt(sum(sample*sample for sample in samples)/len(samples))
        if rms >= 260:
            self.heard_speech = True
            self.silent_samples = 0
        else:
            self.silent_samples += len(samples)
        words = re.findall(r"[а-яё]+|\d+", partial.lower())
        digit_count = sum(word in DIGITS or word.isdigit() for word in words)
        phone = bool(words) and digit_count / len(words) >= 0.65
        pause = 1.28 if phone else 0.64
        return self.heard_speech and bool(partial.strip()) and self.silent_samples >= int(16000*pause)
