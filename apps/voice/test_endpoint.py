from array import array
import unittest
from endpoint import SpeechEndpoint


class EndpointTests(unittest.TestCase):
    def test_normal_sentence_ends_after_640ms_of_silence(self):
        endpoint = SpeechEndpoint()
        self.assertFalse(endpoint.observe(array('h',[1500]*1280).tobytes(), 'сколько стоит занятие'))
        for _ in range(7):
            self.assertFalse(endpoint.observe(bytes(2560),'сколько стоит занятие'))
        self.assertTrue(endpoint.observe(bytes(2560),'сколько стоит занятие'))

    def test_phone_dictation_preserves_longer_pauses(self):
        endpoint = SpeechEndpoint()
        endpoint.observe(array('h',[1500]*1280).tobytes(),'семь девять ноль ноль')
        for _ in range(15):
            self.assertFalse(endpoint.observe(bytes(2560),'семь девять ноль ноль'))
        self.assertTrue(endpoint.observe(bytes(2560),'семь девять ноль ноль'))

    def test_silence_and_empty_recognition_do_not_start_a_turn(self):
        endpoint=SpeechEndpoint()
        for _ in range(40):
            self.assertFalse(endpoint.observe(bytes(2560),''))
        endpoint.observe(array('h',[1500]*1280).tobytes(),'')
        self.assertFalse(endpoint.observe(bytes(32000),''))
