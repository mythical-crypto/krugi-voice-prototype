from array import array
import json
import unittest
from recognition import StreamingRecognition


class NativeSegments:
    def __init__(self):
        self.partial='семь девять'
        self.segment=''
        self.final=''
        self.accept_next=False
        self.resets=0
    def AcceptWaveform(self, pcm):
        accepted=self.accept_next
        self.accept_next=False
        return accepted
    def PartialResult(self):return json.dumps({'partial':self.partial})
    def Result(self):
        self.partial=''
        return json.dumps({'text':self.segment})
    def FinalResult(self):return json.dumps({'text':self.final})
    def Reset(self):self.resets+=1


class RecognitionTests(unittest.TestCase):
    def test_native_half_second_digit_segment_is_not_emitted_early(self):
        native=NativeSegments()
        stream=StreamingRecognition(native)
        speech=array('h',[1500]*1280).tobytes()
        stream.accept(speech)
        for _ in range(6):self.assertIsNone(stream.accept(bytes(2560))[1])
        native.segment='семь девять'
        native.accept_next=True
        self.assertIsNone(stream.accept(bytes(2560))[1])
        native.partial='ноль ноль ноль ноль ноль ноль ноль ноль два'
        stream.accept(speech)
        for _ in range(15):self.assertIsNone(stream.accept(bytes(2560))[1])
        native.final=native.partial
        final=stream.accept(bytes(2560))[1]
        self.assertEqual(final,'семь девять ноль ноль ноль ноль ноль ноль ноль ноль два')
        self.assertEqual(native.resets,1)
