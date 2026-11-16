"""Real phone ASR with a pause longer than Vosk's native endpoint."""
import json
import numpy as np
from vosk import Model,KaldiRecognizer,SetLogLevel
from piper_speech import SpeechSynthesizer
from recognition import StreamingRecognition
from speech import ROOT

SetLogLevel(-1)
tts=SpeechSynthesizer()
audio=[]
for index,text in enumerate(['семь девять',' '.join(['ноль']*8+['два'])]):
    packets=[]
    tts.synthesize(text,lambda pcm,rate:packets.append(pcm))
    source=np.frombuffer(b''.join(packets),dtype='<i2')
    resampled=np.interp(np.arange(0,len(source),tts.sample_rate/16000),np.arange(len(source)),source).astype('<i2').tobytes()
    audio.append(resampled)
    audio.append(bytes(int(16000*(0.72 if index==0 else 1.6))*2))
pcm=b''.join(audio)
model=Model(str(ROOT/'tools/vosk/vosk-model-small-ru-0.22'))
recognition=StreamingRecognition(KaldiRecognizer(model,16000))
finals=[]
native_segments=[]
for offset in range(0,len(pcm),2560):
    partial,final=recognition.accept(pcm[offset:offset+2560])
    for segment in recognition.segments:
        if segment not in native_segments:native_segments.append(segment)
    if final:finals.append(final)
result={'pauseBetweenGroupsMs':720,'nativeSegmentsObserved':native_segments,'finals':finals,'endpointPassed':len(finals)==1 and finals[0].startswith('семь девять'),'exactDigitsRecognized':len(finals)==1 and finals[0].split()==['семь','девять']+['ноль']*8+['два']}
(ROOT/'runtime/phone-asr-report.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(result,ensure_ascii=True))
if not result['endpointPassed']:raise SystemExit(1)
