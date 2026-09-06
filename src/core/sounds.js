import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Original synthesized effects. The generated sound data is dedicated under CC0-1.0. */
export function synthesizeEffect(profile){
  if(!['magic','time'].includes(profile))throw new Error('Unknown built-in sound')
  const rate=48000,duration=profile==='magic'?.8:1.2,count=Math.round(duration*rate),buffer=Buffer.alloc(44+count*2)
  buffer.write('RIFF');buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(rate,24);buffer.writeUInt32LE(rate*2,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(count*2,40)
  const notes=profile==='magic'?[660,880,1320,1760]:[1046.5,1318.5,1568]
  for(let i=0;i<count;i++){
    const t=i/rate;let sample=0
    notes.forEach((f,n)=>{const local=t-n*.085;if(local>=0)sample+=Math.sin(2*Math.PI*f*local)*Math.exp(-local*(profile==='magic'?8:5))*Math.min(1,local/.01)*.08})
    sample*=Math.min(1,(duration-t)/.08);buffer.writeInt16LE(Math.round(Math.max(-.7,Math.min(.7,sample))*32767),44+i*2)
  }
  return {buffer,duration,mime:'audio/wav'}
}
export async function addBuiltInEffects(project,timeline,assets,directory){
  if(project.style.soundEffects===false)return
  for(const kind of ['magic','time']){
    const custom=kind==='magic'?project.style.travelSoundAssetId:project.style.timeSoundAssetId
    const cues=timeline.cues.filter(c=>c.kind===kind)
    if(custom||!cues.length)continue
    const sound=synthesizeEffect(kind),assetId='_builtin_'+kind,file=path.join(directory,assetId+'.wav')
    await fs.mkdir(directory,{recursive:true,mode:0o700});await fs.writeFile(file,sound.buffer,{flag:'wx',mode:0o600})
    assets[assetId]={path:file,kind:'audio',mime:sound.mime,metadata:{duration:sound.duration,sampleRate:48000,channels:1}}
    for(const cue of cues)timeline.audioOverlays.push({assetId,start:cue.start,gainDb:kind==='magic'?-7:-12,maxDuration:cue.end-cue.start})
  }
  timeline.audioOverlays.sort((a,b)=>a.start-b.start)
}
