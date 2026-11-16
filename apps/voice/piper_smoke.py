"""Real Russian synthesis/ASR comparison and ready-to-listen WAV examples."""
import json
import time
import wave
import sys
from pathlib import Path

import numpy as np
from vosk import Model,KaldiRecognizer,SetLogLevel
from piper_speech import SpeechSynthesizer
from speech import ROOT,prepare_text

SetLogLevel(-1)
sys.stdout.reconfigure(encoding='utf-8')
directory=ROOT/'runtime/piper-fixtures'
directory.mkdir(parents=True,exist_ok=True)
started=time.perf_counter()
tts=SpeechSynthesizer()
initialization_ms=round((time.perf_counter()-started)*1000)
asr_model=Model(str(ROOT/'tools/vosk/vosk-model-small-ru-0.22'))
cases=[
 ('greeting','Здравствуйте, гончарная студия Круги, меня зовут Светлана, слушаю вас'),
 ('prices','Гончарный круг — 3200 рублей. Ручная лепка — 2800 рублей. Свидание для двоих — 5600 рублей за пару.'),
 ('quote','Баланс 600 бонусов, применим 600. К оплате 2600 рублей.'),
 ('phone','Я услышала номер 7 9 0 0 0 0 0 0 0 0 2. Всё верно?'),
 ('faq','В занятие входят глина, инструменты, помощь мастера, обжиг и прозрачная глазурь одного изделия.'),
 ('visitor-hearing','Да здравствуйте, меня слышно?'),
 ('visitor-prices','Смотрите, я хочу узнать, сколько это будет по стоимости.'),
 ('visitor-correction','Нет, я хочу, чтобы вы сориентировали меня по стоимости.'),
 ('visitor-wheel','А сколько стоит занятие на гончарном круге?'),
]
report={'engine':'Piper 1.8.0, ru_RU-irina-medium','initializationMs':initialization_ms,'samples':[],'physicalMicrophoneTested':False}
for name,text in cases:
    packets=[]
    metrics=tts.synthesize(text,lambda pcm,rate:packets.append(pcm))
    pcm=b''.join(packets)
    with wave.open(str(directory/(name+'.wav')),'wb') as output:
        output.setnchannels(1);output.setsampwidth(2);output.setframerate(tts.sample_rate);output.writeframes(pcm)
    audio=np.frombuffer(pcm,dtype='<i2')
    resampled=np.interp(np.arange(0,len(audio),tts.sample_rate/16000),np.arange(len(audio)),audio).astype('<i2').tobytes()
    with wave.open(str(directory/(name+'-16k.wav')),'wb') as output:
        output.setnchannels(1);output.setsampwidth(2);output.setframerate(16000);output.writeframes(resampled)
    recognizer=KaldiRecognizer(asr_model,16000)
    recognized=[]
    for offset in range(0,len(resampled),2560):
        if recognizer.AcceptWaveform(resampled[offset:offset+2560]):recognized.append(json.loads(recognizer.Result()).get('text',''))
    recognized.append(json.loads(recognizer.FinalResult()).get('text',''))
    item={'name':name,'text':text,'spokenText':prepare_text(text),'asr':' '.join(recognized).strip(),**metrics,'rtf':round(metrics['durationMs']/1000/metrics['audioSeconds'],3)}
    report['samples'].append(item)
    print(json.dumps(item,ensure_ascii=False))
(ROOT/'runtime/piper-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
