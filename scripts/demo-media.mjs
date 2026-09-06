// Original CC0 anonymous fixture media: geometry and oscillator tones, never real speech.
import { deflateSync } from 'node:zlib'
export function demoPng(){
  const width=320,height=240,raw=Buffer.alloc((width*3+1)*height)
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    let c=y>185?[132,174,115]:[246,232,203]
    if((x-258)**2+(y-48)**2<30**2)c=[248,210,93]
    if(y>105&&y<225&&Math.abs(x-115)<(y-80)*.45)c=[89,156,182]
    if((x-115)**2+(y-82)**2<28**2)c=[249,212,183]
    if((x-105)**2+(y-80)**2<2**2||(x-126)**2+(y-80)**2<2**2)c=[50,65,71]
    const at=y*(width*3+1)+1+x*3;raw[at]=c[0];raw[at+1]=c[1];raw[at+2]=c[2]
  }
  function chunk(type,data){const b=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const byte of b){crc^=byte;for(let k=0;k<8;k++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);b.copy(out,4);out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out}
  const head=Buffer.alloc(13);head.writeUInt32BE(width);head.writeUInt32BE(height,4);head[8]=8;head[9]=2
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))])
}
export function demoWav(){
  const rate=48000,n=rate*4,b=Buffer.alloc(44+n*2)
  b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40)
  for(let i=0;i<n;i++){const t=i/rate,active=t>=.2&&t<=.8||t>=2.6&&t<=3.3;b.writeInt16LE(active?Math.round(Math.sin(t*2*Math.PI*330)*1800):0,44+i*2)}
  return b
}
export const demoSegments=[{start:.2,end:.8,text:'你好，小星星。',dialogueId:'line-one'},{start:2.6,end:3.3,text:'我们出发。',dialogueId:'line-two'}]
export const demoScenes=imageAssetId=>[
  {id:'scene-one',imageAssetId,action:'纸偶发现一颗星星。',dialogue:[{id:'line-one',characterId:'hero',text:'你好，小星星。',mode:'thought'}],transition:'cut'},
  {id:'scene-two',imageAssetId,action:'纸偶出发旅行。',dialogue:[{id:'line-two',characterId:'friend',text:'我们出发。',mode:'burst'}],transition:'magic'}
]
