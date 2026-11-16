"""Keep Vosk's internal segments until the application endpoint is satisfied."""
import json
from endpoint import SpeechEndpoint


class StreamingRecognition:
    def __init__(self, recognizer):
        self.recognizer = recognizer
        self.endpoint = SpeechEndpoint()
        self.segments = []
        self.displayed = ""

    def accept(self, pcm):
        if self.recognizer.AcceptWaveform(pcm):
            segment = json.loads(self.recognizer.Result()).get('text','').strip()
            if segment:
                self.segments.append(segment)
            partial = ''
        else:
            partial = json.loads(self.recognizer.PartialResult()).get('partial','').strip()
        combined = ' '.join(self.segments + ([partial] if partial else []))
        changed = combined if combined != self.displayed else None
        self.displayed = combined
        if self.endpoint.observe(pcm, combined):
            tail = json.loads(self.recognizer.FinalResult()).get('text','').strip()
            final = ' '.join(self.segments + ([tail] if tail else []))
            self.recognizer.Reset()
            self.endpoint.reset()
            self.segments = []
            self.displayed = ''
            return None, final
        return changed, None
