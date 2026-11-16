"""Split the verified portable ZIP into GitHub-sized assets and a readable offline launcher."""
from pathlib import Path
import argparse
import hashlib
import json

ROOT=Path(__file__).resolve().parents[1]


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream,'sha256').hexdigest()


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('archive',type=Path)
    parser.add_argument('--output',type=Path,default=ROOT/'runtime/release-assets')
    args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=True)
    parts=[]
    chunk_size=1_800_000_000
    with args.archive.open('rb') as source:
        index=1
        while source.tell()<args.archive.stat().st_size:
            name=args.archive.name+f'.{index:03d}'
            path=args.output/name
            remaining=chunk_size
            digest=hashlib.sha256()
            with path.open('wb') as target:
                while remaining:
                    block=source.read(min(8*1024*1024,remaining))
                    if not block:break
                    target.write(block);digest.update(block);remaining-=len(block)
            parts.append({'name':name,'bytes':path.stat().st_size,'sha256':digest.hexdigest()})
            index+=1
    manifest={'version':'0.1.0','archive':{'name':args.archive.name,'bytes':args.archive.stat().st_size,'sha256':sha(args.archive)},'parts':parts}
    manifest_text=json.dumps(manifest,indent=2)
    (args.output/'Krugi-Windows-x64.parts.json').write_text(manifest_text+'\n',encoding='utf-8')
    prefix='\r\n'.join([
        '@echo off','setlocal','set "KRUGI_RELEASE_FILE=%~f0"','set "KRUGI_RELEASE_DIR=%~dp0"',
        'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$body=[IO.File]::ReadAllText($env:KRUGI_RELEASE_FILE,[Text.Encoding]::UTF8); $marker=\'#\'+\' KRUGI_POWERSHELL\'; & ([scriptblock]::Create($body.Substring($body.IndexOf($marker)+$marker.Length)))"',
        'if errorlevel 1 pause','exit /b %errorlevel%','# KRUGI_POWERSHELL','',
    ])
    payload="$manifest = @'\n"+manifest_text+"\n'@ | ConvertFrom-Json\n"+(ROOT/'scripts/restore-release.ps1').read_text(encoding='utf-8-sig')
    (args.output/'START-Krugi.cmd').write_bytes((prefix+payload.replace('\r\n','\n').replace('\n','\r\n')).encode('utf-8'))
    print(json.dumps({'assets':parts,'archiveSha256':manifest['archive']['sha256'],'launcher':str(args.output/'START-Krugi.cmd')},ensure_ascii=True))


if __name__=='__main__':main()
