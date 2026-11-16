"""Pinned Russian Piper voice. No downloads are performed by the running application."""
import hashlib
import json
from pathlib import Path
import shutil
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
DEST=ROOT/'tools/piper'
REVISION='e9ab671f2a0e50a701b34361136ba3e6a3a9eb0c'
FILES={
    'ru_RU-irina-medium.onnx':'8ff38212d23da300bbe3705c645e6e5b9475f0bfde01558eb17813e22acaaaaa',
    'ru_RU-irina-medium.onnx.json':'c2ec28bb38e2b59e93b959b3e40348c1afebbd272f30fed5d41205d08e98a9d7',
    'MODEL_CARD':'f4fc2deb0e8c6219f29202b8dd06c9638c5ffd50ad5c6b2c90cf1aa59d507593',
}

def sha256(path):
    digest=hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):
            digest.update(block)
    return digest.hexdigest()

DEST.mkdir(parents=True,exist_ok=True)
assets=[]
for name,expected in FILES.items():
    path=DEST/name
    url=f'https://huggingface.co/rhasspy/piper-voices/resolve/{REVISION}/ru/ru_RU/irina/medium/{name}'
    if not path.is_file() or sha256(path)!=expected:
        temporary=path.with_suffix(path.suffix+'.partial')
        with urllib.request.urlopen(url,timeout=120) as source,temporary.open('wb') as output:
            shutil.copyfileobj(source,output)
        if sha256(temporary)!=expected:
            raise RuntimeError('Piper SHA256 mismatch: '+name)
        temporary.replace(path)
    assets.append({'path':name,'url':url,'sha256':expected})
(DEST/'assets-lock.json').write_text(json.dumps({'revision':REVISION,'runtime':'piper-tts==1.8.0','assets':assets},indent=2)+'\n',encoding='utf-8')
license_path=ROOT/'tools/python/venv/Lib/site-packages/piper_tts-1.8.0.dist-info/licenses/COPYING'
shutil.copyfile(license_path,DEST/'Piper-COPYING')
print('Russian Piper assets ready; SHA256 verified.')
