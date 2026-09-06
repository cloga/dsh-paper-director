import { ProjectError } from './model.js'
import { safeMessage } from './worker.js'

export function publicError(error){
  if(!(error instanceof ProjectError))return {code:'OPERATION_FAILED',message:'操作没有完成，请检查素材或联系家长。'}
  const code=/^[A-Z][A-Z0-9_]{0,79}$/.test(error.code||'')?error.code:'OPERATION_FAILED'
  return {code,message:safeMessage(error.message)}
}
/** Diagnostics are not a channel for worker or SDK paths/credentials. */
export function publicWarnings(values=[]){
  const result=[]
  for(const value of Array.isArray(values)?values.slice(0,64):[]){
    const code=typeof value==='object'&&value?String(value.code||''):''
    const raw=typeof value==='string'?value:String(value?.message||'')
    let warning
    if(code==='RECORDING_CLOCK')warning={code:'RECORDING_CLOCK',message:'录音时间标签有偏差，时序按已解码的声音顺序对齐，请试听核对。'}
    else if(/clip|full scale/i.test(raw))warning={code:'AUDIO_CLIPPED',message:'混音出现过大的音量，请降低声音后再检查。'}
    else if(/padding|padded|missing.*sample/i.test(raw))warning={code:'AUDIO_PADDING',message:'音频容器末尾存在微小采样差异，已补齐尾部静音。'}
    else if(/join|fade|truncat/i.test(raw))warning={code:'AUDIO_FADE',message:'剪接或音效截断处已做短淡化。'}
    else if(code==='ALIGNMENT_NEEDS_REVIEW'||/alignment|transcript|ASR/i.test(raw))warning={code:'ALIGNMENT_NEEDS_REVIEW',message:'部分台词对应或转写需要试听确认。'}
    else if(code==='UNMATCHED_SPEECH_RETAINED'||/unmatched/i.test(raw))warning={code:'UNMATCHED_SPEECH_RETAINED',message:'尚未对应的发声仍保留，请试听检查。'}
    else warning={code:'MEDIA_REVIEW',message:'这份结果有需要人工核对的媒体提示。'}
    if(!result.some(w=>w.code===warning.code))result.push(warning)
  }
  return result
}
