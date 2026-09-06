"""Validate the public documentation media and record independently measured metadata."""
from pathlib import Path
import hashlib,json,sys
from PIL import Image,ImageSequence
ROOT=Path(__file__).resolve().parents[2]
MEDIA=ROOT/'docs'/'media'
NAMES=['install-overview.png','configuration-map.png','storyboard.png','recording.png','review.png','movie.png','studio-flow.gif']
result={'license':'MIT','source':'Original explanatory diagrams and isolated real UI captures; generated anonymous geometry/oscillator audio only.','files':[]}
for name in NAMES:
    path=MEDIA/name;content=path.read_bytes()
    with Image.open(path) as image:
        item={'file':name,'format':image.format,'width':image.width,'height':image.height,'frames':getattr(image,'n_frames',1),'bytes':len(content),'sha256':hashlib.sha256(content).hexdigest()}
        if image.format=='GIF':
            item['duration_ms']=sum(frame.info.get('duration',0) for frame in ImageSequence.Iterator(image))
            assert image.width==1000 and image.height==742 and item['frames']==5
            assert 3000<=item['duration_ms']<=8000 and len(content)<2*1024*1024
        else:
            assert image.format=='PNG' and image.width==1000 and image.height in (650,700)
        result['files'].append(item)
manifest=MEDIA/'manifest.json'
if '--write' in sys.argv:manifest.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
else:assert json.loads(manifest.read_text(encoding='utf8'))==result,'Manifest differs from the actual media; review changes before updating it.'
print(json.dumps(result,ensure_ascii=False,indent=2))
