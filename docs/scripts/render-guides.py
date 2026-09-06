"""Render explanatory documentation diagrams and labelled, fixed-size capture frames.
No credentials, production state or bundled proprietary font files are used.
"""
from pathlib import Path
import sys,json
from PIL import Image,ImageDraw,ImageFont
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'python'))
from paper_director.fonts import choose_font
OUT=ROOT/'docs'/'media';OUT.mkdir(parents=True,exist_ok=True)
TMP=ROOT/'.test-output'/'docs-media';TMP.mkdir(parents=True,exist_ok=True)
FONT=choose_font(None,['纸上小导演安装配置使用家长工作室模型本地录音语音预设目录','ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789→：，。'])
INK='#294e43';MUTED='#657468';PAPER='#f7f1e5';PINK='#aa4568';GREEN='#267b75';GOLD='#c3a14d'
def font(size):return ImageFont.truetype(str(FONT),size)
def canvas():
 im=Image.new('RGB',(1000,650),PAPER);return im,ImageDraw.Draw(im)
def text(draw,xy,value,size=22,fill=INK):draw.text(xy,value,font=font(size),fill=fill)
def card(draw,box,n,title,lines,color=PINK):
 x,y,x2,y2=box;draw.rounded_rectangle(box,16,fill='#fffdf8',outline='#d8d1bd',width=2)
 draw.ellipse((x+20,y+18,x+58,y+56),fill=color)
 text(draw,(x+31,y+18),str(n),25,'white');text(draw,(x+74,y+20),title,25)
 for i,line in enumerate(lines):text(draw,(x+25,y+75+i*29),line,20,MUTED)
def arrow(draw,points):
 draw.line(points,fill=GOLD,width=4,joint='curve');x,y=points[-1];px,py=points[-2]
 if abs(x-px)>abs(y-py):d=1 if x>px else -1;draw.polygon([(x,y),(x-10*d,y-7),(x-10*d,y+7)],fill=GOLD)
 else:d=1 if y>py else -1;draw.polygon([(x,y),(x-7,y-10*d),(x+7,y-10*d)],fill=GOLD)
im,d=canvas()
text(d,(40,27),'安装：家长先准备，孩子再创作',36)
text(d,(42,84),'四步接入原来的DSH · 完整命令在图下方，可直接复制修改',19,MUTED)
card(d,(40,137,480,314),1,'准备媒体环境',['Python 3.11+ 的独立虚拟环境','安装媒体依赖，并准备中文字体'])
card(d,(520,137,960,314),2,'安装DSH插件',['确定原来使用的 Profile','固定安装 v0.1.0，不换另一套服务'])
card(d,(40,365,480,550),3,'安装用户 preset',['安装到核对过的用户预设目录','不修改自带 preset，不覆盖已有文件'])
card(d,(520,365,960,550),4,'配置并回到原 App',['配置解释器／本地模型或人工时标','重启原 Profile，刷新原来的 GUI'])
arrow(d,[(481,225),(518,225)]);arrow(d,[(740,315),(740,337),(260,337),(260,363)]);arrow(d,[(481,455),(518,455)])
text(d,(42,587),'安装流程示意图（不是终端截图） · 插件包和用户 preset 是两个步骤',19,MUTED)
im.save(OUT/'install-overview.png',optimize=True)

im,d=canvas();text(d,(40,27),'配置留在 Host，工作室只显示准备状态',34)
text(d,(42,83),'家长/老师配置；孩子不需要看到文件路径、模型密钥或命令行',19,MUTED)
columns=[(40,'媒体环境（必需）',[('pythonPath','虚拟环境中的 Python'),('fontPath','留空时自动查找字体'),('工作室检查','需要支持中文与视频编码')]),
 (350,'录音对齐',[('asrEngine','whisper 或 vosk'),('asrModelPath','已准备的本地模型目录'),('没有模型？','使用整段录音上的人工时标')]),
 (660,'Azure旁白（可选）',[('allowCloudTts','默认 false，明确开启才用'),('azureRegion','填写真实服务区域'),('azureKeyEnv','环境变量名，不是密钥')])]
for i,(x,title,rows) in enumerate(columns):
 d.rounded_rectangle((x,140,x+300,474),15,fill='#fffdf8',outline='#d8d1bd',width=2)
 d.rectangle((x+1,156,x+299,193),fill='#e9efdf');text(d,(x+18,159),title,23,GREEN)
 for j,(key,value) in enumerate(rows):text(d,(x+18,218+j*79),key,21);text(d,(x+18,249+j*79),value,17,MUTED)
d.rounded_rectangle((40,505,960,593),12,fill='#eadcb7')
text(d,(61,517),'导演助手使用哪个AI，在DSH的模型设置里选择。',22)
text(d,(61,553),'故事/台词/转写可能发送给配置的模型；原始录音不用于云端转写。',18,MUTED)
text(d,(42,614),'配置关系示意图（不是配置界面截图） · 图中不包含任何真实密钥',16,MUTED)
im.save(OUT/'configuration-map.png',optimize=True)

capture=TMP/'capture.json'
if capture.exists():
 data=json.loads(capture.read_text(encoding='utf8'))
 for item in data['captures']:
  raw=Image.open(TMP/item['image']).convert('RGB')
  if raw.size!=(1000,700):raise RuntimeError('All captures must use the fixed 1000x700 viewport')
  frame=Image.new('RGB',(1000,742),'#234e42');frame.paste(raw,(0,42));draw=ImageDraw.Draw(frame)
  text(draw,(20,8),item['label'],20,'white')
  frame.save(TMP/(item['name']+'-labelled.png'),optimize=True)
 steps=[]
 durations=[1300,1800,1500,1000,2100]
 for item,duration in zip(data['captures'][:5],durations):
  cursor=item.get('cursor')
  if cursor and not(0<=cursor[0]<1000 and 0<=cursor[1]<700):cursor=None
  step={'image':item['name']+'-labelled.png','duration_ms':duration}
  if cursor:step['cursor']=[cursor[0],cursor[1]+42]
  steps.append(step)
 spec={'output':'../../docs/media/studio-flow.gif','colors':256,'loop':0,'steps':steps}
 (TMP/'flow-spec.json').write_text(json.dumps(spec,ensure_ascii=False,indent=2),encoding='utf8')
print('Created installation/configuration diagrams and labelled capture spec when available.')
