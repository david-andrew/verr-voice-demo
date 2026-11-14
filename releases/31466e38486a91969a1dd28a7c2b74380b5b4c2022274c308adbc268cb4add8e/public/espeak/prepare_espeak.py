"""Install pinned public eSpeak NG WASM/data and corresponding sources; no user inputs.

Only named files are extracted. The app fetches these from its own static host,
never from npm/CDNs at runtime. Sources are offered beside the GPL binaries.
"""
from pathlib import Path
import hashlib,io,json,shutil,subprocess,tarfile,tempfile

def _scratch():
    from pathlib import Path
    d = Path.home() / 'dev' / 'tmp' / 'verr-voice-checks'
    d.mkdir(parents=True, exist_ok=True)
    return d

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'public/espeak'
ARTIFACTS=[
 ('spellophone-0.2.1.tgz','https://registry.npmjs.org/@spelling-creator/spellophone/-/spellophone-0.2.1.tgz','87b689c9676ad68170133a4f230302d892a036e68b38aa7c08c0219a06763544'),
 ('spellophone-source.tar.gz','https://codeload.github.com/Spelling-Creator/spellophone/tar.gz/6d51a872d54a773e4969d7130fdaed665b2d6d18','6702e673c93ea1d8d90300a162d64aaab9fdc23737068173ec54e0c0ca4c58c6'),
 ('espeak-ng-1.52.0-source.tar.gz','https://codeload.github.com/espeak-ng/espeak-ng/tar.gz/refs/tags/1.52.0','bb4338102ff3b49a81423da8a1a158b420124b055b60fa76cfb4b18677130a23'),
]
FILES=['dist/browser.js','dist/core-w4y-vCu9.js','wasm/espeak-ng.js','wasm/espeak-ng.wasm','LICENSE','espeak-ng-data/manifest.json','espeak-ng-data/core.bin.gz','espeak-ng-data/en_dict.gz','espeak-ng-data/fr_dict.gz','espeak-ng-data/el_dict.gz','espeak-ng-data/de_dict.gz']
with tempfile.TemporaryDirectory(dir=_scratch()) as temp:
 fetched=[]
 for name,url,digest in ARTIFACTS:
  target=Path(temp)/name
  existing=OUT/'sources'/name
  if existing.exists():shutil.copyfile(existing,target)
  else:subprocess.run(['curl','-4','-fL','--retry','2','--max-time','120','-o',str(target),url],check=True)
  if hashlib.sha256(target.read_bytes()).hexdigest()!=digest:raise ValueError(f'Checksum mismatch: {name}')
  fetched.append(target)
 with tarfile.open(fetched[0]) as archive:
  for name in FILES:
   data=archive.extractfile('package/'+name).read()
   if name.endswith('.js'):data=data.split(b'//# sourceMappingURL=')[0] # Source archive is offered below.
   if name=='espeak-ng-data/manifest.json':
    manifest=json.loads(data);manifest['dictionaries']={lang:manifest['dictionaries'][lang] for lang in ['en','fr','el','de']};data=(json.dumps(manifest,indent=2)+'\n').encode()
   path=OUT/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
 sources=[]
 for target,(_,url,digest) in zip(fetched[1:],ARTIFACTS[1:]):
  name='sources/'+target.name;dest=OUT/name;dest.parent.mkdir(exist_ok=True);shutil.copyfile(target,dest);sources.append(name)
 files={name:hashlib.sha256((OUT/name).read_bytes()).hexdigest() for name in FILES+sources}
 (OUT/'integrity.json').write_text(json.dumps({'package':'@spelling-creator/spellophone@0.2.1','engine':'eSpeak NG 1.52.0','license':'GPL-3.0-or-later','upstream':ARTIFACTS,'files':files},indent=2)+'\n')
print('Prepared self-hosted pronunciation engine, English/French/Greek/German dictionaries and source archives.')
