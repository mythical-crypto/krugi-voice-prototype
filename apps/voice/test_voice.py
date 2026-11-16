"""Small deterministic checks; real-model evidence is in voice_smoke.py."""
import base64
import unittest

from speech import cardinal, prepare_text
from worker import validate


class VoiceTests(unittest.TestCase):
    def test_numbers_and_price(self):
        self.assertEqual(cardinal(3200), "три тысячи двести")
        self.assertEqual(cardinal(2800), "две тысячи восемьсот")
        self.assertEqual(cardinal(5600), "пять тысяч шестьсот")
        self.assertEqual(cardinal(90), "девяносто")
        self.assertEqual(prepare_text("Цена 3 200 ₽, бонусы 20%."), "Цена три тысячи двести  рублей, бонусы двадцать процентов.")

    def test_phone_spoken_digit_by_digit(self):
        self.assertEqual(prepare_text("+7 (900) 123-45-67"), "семь девять ноль ноль один два три четыре пять шесть семь")
        self.assertTrue(prepare_text("Номер +79001234567 верно?").endswith("шесть семь верно?"))

    def test_no_missing_phone_inference(self):
        self.assertNotIn("девять ноль ноль", prepare_text("900"))

    def test_message_validation(self):
        for message in [None, {}, {"type": "shell"}, {"type": "tts", "sessionId": "s", "turnId": True, "text": "x"}, {"type": "pcm", "sessionId": "", "audio": ""}, {"type": "tts", "sessionId": "s", "turnId": 1, "text": 42}, {"type": "asr_start", "sessionId": "s", "shell": "x"}]:
            with self.assertRaises(ValueError):
                validate(message)
        self.assertEqual(validate({"type": "shutdown"})["type"], "shutdown")

    def test_pcm_round_trip(self):
        pcm = bytes(range(100))
        self.assertEqual(base64.b64decode(base64.b64encode(pcm), validate=True), pcm)


if __name__ == "__main__":
    unittest.main()
