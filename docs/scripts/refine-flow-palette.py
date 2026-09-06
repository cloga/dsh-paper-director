"""Documentation-only palette refinement after the standard UI-flow composer.
Use full-resolution per-keyframe palettes without dithering to keep UI text and
small saturated illustration colours sharp. No UI state is fabricated here.
"""
from pathlib import Path
import json,sys
from PIL import Image,ImageDraw

spec_path=Path(sys.argv[1]).resolve()
spec=json.loads(spec_path.read_text(encoding='utf8'))
frames=[];durations=[];size=None
for step in spec['steps']:
    image=Image.open(spec_path.parent/step['image']).convert('RGB')
    if size is None:size=image.size
    assert image.size==size
    if 'cursor' in step:
        x,y=step['cursor'];draw=ImageDraw.Draw(image)
        draw.polygon([(x,y),(x,y+21),(x+5,y+16),(x+10,y+26),(x+14,y+24),(x+10,y+14),(x+19,y+14)],fill='white',outline='#1a251f',width=1)
    frames.append(image.quantize(colors=128,method=Image.Quantize.MEDIANCUT,dither=Image.Dither.NONE))
    durations.append(step['duration_ms'])
output=(spec_path.parent/spec['output']).resolve()
temporary=output.with_suffix('.tmp.gif')
frames[0].save(temporary,save_all=True,append_images=frames[1:],duration=durations,loop=spec.get('loop',0),disposal=2,optimize=False)
temporary.replace(output)
with Image.open(output) as image:
    assert image.n_frames==len(frames)
    image.seek(len(frames)-1);image.convert('RGB').save(spec_path.parent/'gif-final-refined.png')
print(json.dumps({'frames':len(frames),'size':size,'duration_ms':sum(durations),'bytes':output.stat().st_size,'palette':'128 colours per full-resolution keyframe; no dithering'}))
