# Локальная речь

Процесс JSONL запускается сервером через `tools/python/venv/Scripts/python.exe -u apps/voice/worker.py`. Протокол описан в корневом `PROTOCOL.md`; stdout содержит только события, ошибки и служебные логи идут в stderr.

Вход: mono PCM16 LE, 16 кГц. По умолчанию Piper выдаёт mono PCM16 LE 22,05 кГц пакетами около 80 мс. ASR и TTS работают в разных потоках. Пауза окончания обычной реплики — 640 мс; для диктовки цифр оставлены 1,28 с. Отмена проверяется перед синтезом следующей фразы и выдачей пакетов; устаревшие turnId отбрасываются сервером и интерфейсом.

Окружение и загрузки подготавливает `scripts/setup-voice.ps1`. Python 3.12.13 установлен через uv с `--no-bin --no-registry`, зависимости зафиксированы в requirements.lock.txt. Нет torch, torchaudio, облачных сервисов или загрузок во время разговора. Все файлы моделей проверяются по SHA256 из `tools/moss-tts/assets-lock.json`.

Источники:

- [Vosk small Russian 0.22](https://alphacephei.com/vosk/models), лицензия Apache 2.0; README поставляется внутри модели.
- [Официальный CPU runtime MOSS](https://github.com/OpenMOSS/MOSS-TTS-Nano/tree/8b7bcc9341b3b4ef3a3a58ba1338a7d85ff133eb), Apache 2.0; оригинальный ort_cpu_runtime.py и LICENSE сохранены в tools/moss-tts.
- [MOSS TTS ONNX](https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX/tree/f52645cb467506d8e18e746ddd59482685b74e58) и [аудиокодек ONNX](https://huggingface.co/OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX/tree/ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae); карточки моделей сохранены рядом с файлами.

По умолчанию выбран Piper 1.8.0 и русский ru_RU-irina-medium. Зафиксированные файлы и SHA-256 находятся в tools/piper/assets-lock.json; подготовка — scripts/setup-piper.py. Исходная карточка модели и лицензия runtime сохранены рядом. MOSS/Bella остаётся доступен через KRUGI_TTS=moss. Цены и телефоны перед синтезом преобразуются в русские слова; номер произносится по цифрам и требует отдельного подтверждения посетителем.

Быстрая проверка нового голоса: `tools/python/venv/Scripts/python.exe apps/voice/piper_smoke.py`. Настоящие WAV/ASR и времена сохраняются в runtime/piper-fixtures/ и runtime/piper-report.json. `worker_smoke.py` теперь проверяет выбранный по умолчанию Piper. Старый voice_smoke.py оставлен для сравнения с MOSS.

Проверки:

```powershell
tools/python/venv/Scripts/python.exe -m unittest discover -s apps/voice -p test_*.py
tools/python/venv/Scripts/python.exe apps/voice/voice_smoke.py
tools/python/venv/Scripts/python.exe apps/voice/worker_smoke.py
```

voice_smoke.py синтезирует настоящую речь, сохраняет WAV и пропускает её через Vosk. worker_smoke.py проверяет протокол, одновременный ASR/TTS, отмену, повторный старт и завершение процесса. Отчёты: runtime/voice-report.json, runtime/voice-worker-report.json. WAV: runtime/voice-fixtures. Они подходят для повторного пропуска через браузерный PCM-тракт.

Синтетические записи подтверждают работу моделей и протокола. Проверка физического микрофона и прослушивание человеком в эти сценарии не входят. Ошибки Vosk в окончаниях и названии техники видны в сохранённых расшифровках; при неясном запросе нужно переспросить.
