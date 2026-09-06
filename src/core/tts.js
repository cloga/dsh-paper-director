import { ProjectError, fail, text as boundedText } from './model.js'

const VOICE='zh-CN-XiaoxiaoNeural'
function credentials(config){
  if(config.allowCloudTts!==true||! /^[a-z][a-z0-9]{1,30}$/.test(config.azureRegion||'')||! /^[A-Za-z_][A-Za-z0-9_]*$/.test(config.azureKeyEnv||''))return null
  const key=process.env[config.azureKeyEnv]
  return typeof key==='string'&&key.trim()?{key,region:config.azureRegion}:null
}
export const narrationReady=config=>!!credentials(config)
const escape=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]))
export function inspectPcmWav(buffer){
  if(buffer.length<44||buffer.toString('ascii',0,4)!=='RIFF'||buffer.toString('ascii',8,12)!=='WAVE')fail('TTS_BAD_RESPONSE','语音服务没有返回有效音频。')
  let format=null,size=null
  for(let offset=12;offset+8<=buffer.length;){
    const name=buffer.toString('ascii',offset,offset+4),length=buffer.readUInt32LE(offset+4),body=offset+8
    if(body+length>buffer.length)fail('TTS_BAD_RESPONSE','语音数据不完整。')
    if(name==='fmt '&&length>=16)format={encoding:buffer.readUInt16LE(body),channels:buffer.readUInt16LE(body+2),sampleRate:buffer.readUInt32LE(body+4),bits:buffer.readUInt16LE(body+14)}
    if(name==='data')size=length
    offset=body+length+(length%2)
  }
  if(!format||format.encoding!==1||format.channels!==1||format.sampleRate!==24000||format.bits!==16||!size||size%2)fail('TTS_BAD_RESPONSE','语音格式与请求不一致。')
  const duration=size/(format.sampleRate*format.channels*2)
  if(duration>.0&&duration<=180)return {duration,sampleRate:24000,channels:1,codec:'pcm_s16le',audioStreams:1,videoStreams:0}
  fail('TTS_BAD_RESPONSE','旁白时长超过限制。')
}
/** Only approved text goes to the exact regional Microsoft endpoint. Never retry a POST. */
export async function synthesizeNarration(config,value,{signal,fetchImpl=fetch}={}){
  const c=credentials(config)
  if(!c)fail('TTS_DISABLED','请先由家长配置并开启Azure旁白。',503)
  const text=boundedText(value,500,'narration').trim()
  if(!text)fail('EMPTY_TEXT','旁白文字不能为空。')
  if(signal?.aborted)throw new ProjectError('CANCELLED','任务已取消。')
  const ssml=`<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><voice name="${VOICE}">${escape(text)}</voice></speak>`
  let response
  try{response=await fetchImpl(`https://${c.region}.tts.speech.microsoft.com/cognitiveservices/v1`,{method:'POST',redirect:'manual',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000),headers:{'Ocp-Apim-Subscription-Key':c.key,'Content-Type':'application/ssml+xml','X-Microsoft-OutputFormat':'riff-24khz-16bit-mono-pcm','User-Agent':'dsh-paper-director'},body:ssml})}
  catch{throw new ProjectError('TTS_UNCERTAIN','语音请求结果不确定；为避免重复费用，请让家长检查后再处理。')}
  if(response.status!==200){
    await response.body?.cancel().catch(()=>{})
    if([401,403].includes(response.status))fail('TTS_AUTH','Azure语音授权不可用，请让家长检查配置。',503)
    if(response.status===429)fail('TTS_RATE_LIMIT','Azure语音额度或速率达到限制。',429)
    fail('TTS_HTTP_ERROR','Azure语音服务暂时未完成请求。',502)
  }
  const chunks=[];let bytes=0
  try{
    if(!response.body)throw new Error('Missing body')
    const reader=response.body.getReader()
    for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>16*1024*1024){await reader.cancel();throw new Error('Too large')}chunks.push(Buffer.from(value))}
    const buffer=Buffer.concat(chunks)
    return {buffer,metadata:inspectPcmWav(buffer),voice:VOICE}
  }catch{throw new ProjectError('TTS_UNCERTAIN','语音响应不完整或不可用，可能已产生费用，请让家长检查。')}
}
