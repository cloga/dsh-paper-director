import { createHash, randomUUID } from 'node:crypto'
import { clone, fail, finite, id, object, text } from './model.js'

const RATE=48000
const snap=t=>Math.round(t*RATE)/RATE
const overlap=(a,b)=>a.start<b.end && a.end>b.start
function ranges(input,duration,label) {
  if(!Array.isArray(input)||input.length>50000)fail('INVALID_ALIGNMENT',`Invalid ${label}`)
  return input.map(r=>{object(r,label);const start=finite(r.start,0,duration,'range start'),end=finite(r.end,0,duration,'range end');if(end<=start)fail('INVALID_ALIGNMENT','A range must have positive duration');return {start:snap(start),end:snap(end),...(typeof r.text==='string'?{text:text(r.text,3000,'recognized text')}:{} )}}).sort((a,b)=>a.start-b.start)
}
function dialogue(project){return project.scenes.flatMap(s=>s.dialogue.filter(d=>d.text.trim()).map(d=>({...d,sceneId:s.id})))}
export function validateAlignment(project,input) {
  object(input,'alignment');const duration=finite(input.duration,.05,600,'recording duration')
  if(!Array.isArray(input.utterances)||input.utterances.length>3000)fail('INVALID_ALIGNMENT','Invalid utterances')
  const authors=dialogue(project),expected=new Map(authors.map(d=>[d.id,d])),seen=new Set()
  const utterances=input.utterances.map(u=>{
    object(u,'utterance');const d=expected.get(u.dialogueId)
    if(!d||seen.has(d.id))fail('INVALID_ALIGNMENT','Unknown or duplicate dialogue id in alignment')
    seen.add(d.id)
    if(u.sceneId!==undefined&&u.sceneId!==d.sceneId)fail('INVALID_ALIGNMENT','Dialogue scene identity does not match the author')
    const matchStatus=u.matchStatus||'needs_review'
    if(!['matched','needs_review','unmatched'].includes(matchStatus))fail('INVALID_ALIGNMENT','Unknown alignment status')
    let start=null,end=null
    if(u.start!==null&&u.start!==undefined&&u.end!==null&&u.end!==undefined){start=snap(finite(u.start,0,duration,'utterance start'));end=snap(finite(u.end,0,duration,'utterance end'));if(end<=start)fail('INVALID_ALIGNMENT','A spoken line must have positive duration')}
    if((start===null||end===null)&&matchStatus!=='unmatched')fail('INVALID_ALIGNMENT','Missing times must be explicitly unmatched')
    return {id:id(u.id||randomUUID()),dialogueId:d.id,sceneId:d.sceneId,characterId:d.characterId,start,end,recognizedText:text(u.recognizedText,3000,'recognized text'),matchStatus}
  })
  for(const d of authors)if(!seen.has(d.id))utterances.push({id:randomUUID(),dialogueId:d.id,sceneId:d.sceneId,characterId:d.characterId,start:null,end:null,recognizedText:'',matchStatus:'unmatched'})
  const order=new Map(authors.map((d,i)=>[d.id,i]));utterances.sort((a,b)=>order.get(a.dialogueId)-order.get(b.dialogueId))
  let lastEnd=0
  for(const u of utterances)if(u.start!==null){if(u.start<lastEnd-.001)fail('ALIGNMENT_ORDER','对白时间重叠或顺序不一致，请核对录音。');lastEnd=u.end}
  if(input.warnings!==undefined&&(!Array.isArray(input.warnings)||input.warnings.length>200))fail('INVALID_ALIGNMENT','Too many alignment warnings')
  const warnings=(input.warnings||[]).map(w=>typeof w==='string'?{code:'ALIGNMENT_WARNING',message:text(w,600,'warning')}:{code:text(w.code,80,'warning code','ALIGNMENT_WARNING'),message:text(w.message,600,'warning')})
  return {duration,utterances,speechRanges:ranges(input.speechRanges||[],duration,'speech ranges'),unmatchedSpeech:ranges(input.unmatchedSpeech||[],duration,'unmatched speech'),method:text(input.method,120,'alignment method','provided'),warnings}
}
export function retainedRanges(start,end,cuts=[]) {
  let cursor=start;const result=[]
  for(const c of [...cuts].sort((a,b)=>a.start-b.start)){
    if(c.end<=cursor||c.start>=end)continue
    if(c.start>cursor)result.push({sourceStart:cursor,sourceEnd:Math.min(c.start,end)})
    cursor=Math.max(cursor,c.end);if(cursor>=end)break
  }
  if(cursor<end)result.push({sourceStart:cursor,sourceEnd:end})
  return result
}
const retainedDuration=(start,end,cuts)=>retainedRanges(start,end,cuts).reduce((n,r)=>n+r.sourceEnd-r.sourceStart,0)
function checkedCuts(project) {
  const result=[...project.edits].sort((a,b)=>a.start-b.start)
  let end=0
  const known=project.alignment.utterances.filter(u=>u.start!==null)
  for(const c of result){
    finite(c.start,0,project.alignment.duration,'cut start');finite(c.end,0,project.alignment.duration,'cut end')
    if(c.start<end||c.end<=c.start)fail('INVALID_EDIT','Cut ranges overlap or have no duration')
    if(known.some(u=>overlap(c,u)))fail('SPEECH_PROTECTED','不能删除已对应的对白。')
    if(!c.allowUnmatchedSpeech&&project.alignment.unmatchedSpeech.some(r=>overlap(c,r)))fail('CONFIRMATION_REQUIRED','额外发声没有获得删除确认。',409)
    end=c.end
  }
  return result
}
export function proposePauseEdit(project,request) {
  if(!project.alignment)fail('ALIGNMENT_REQUIRED','请先把完整录音与台词对应起来。')
  object(request,'pause edit');const targetSeconds=finite(request.targetSeconds,.25,3,'target pause')
  id(request.afterDialogueId);id(request.beforeDialogueId)
  const aligned=project.alignment.utterances,afterIndex=aligned.findIndex(u=>u.dialogueId===request.afterDialogueId)
  const before=aligned[afterIndex+1],after=aligned[afterIndex]
  if(!after||!before||before.dialogueId!==request.beforeDialogueId||after.end===null||before.start===null)fail('INVALID_EDIT','请选择相邻且已经对齐的两句对白。')
  const edits=checkedCuts(project),gap=retainedRanges(after.end,before.start,edits)
  const currentSeconds=gap.reduce((n,r)=>n+r.sourceEnd-r.sourceStart,0),remove=Math.max(0,currentSeconds-targetSeconds)
  const keepAfter=Math.min(.4,targetSeconds*.55);let position=0;const cuts=[]
  if(remove>.001)for(const r of gap){const length=r.sourceEnd-r.sourceStart,lo=Math.max(position,keepAfter),hi=Math.min(position+length,keepAfter+remove);if(hi>lo)cuts.push({start:snap(r.sourceStart+lo-position),end:snap(r.sourceStart+hi-position)});position+=length}
  const known=aligned.filter(u=>u.start!==null)
  if(cuts.some(c=>known.some(u=>overlap(c,u))))fail('SPEECH_PROTECTED','不能删除已对应的对白。')
  const uncertain=[...project.alignment.unmatchedSpeech,...project.alignment.speechRanges.filter(r=>!known.some(u=>u.start<=r.start&&u.end>=r.end))]
  const warnings=cuts.some(c=>uncertain.some(r=>overlap(c,r)))?[{code:'UNMATCHED_SPEECH',message:'这里有尚未确认的发声，请先试听，不能直接当作静音。'}]:[]
  const normalized={afterDialogueId:after.dialogueId,beforeDialogueId:before.dialogueId,targetSeconds}
  const proposal={projectId:project.id,baseRevision:project.revision,request:normalized,currentSeconds:snap(currentSeconds),targetSeconds,removedSeconds:snap(cuts.reduce((n,c)=>n+c.end-c.start,0)),cuts,warnings,requiresConfirmation:warnings.length>0}
  proposal.id=createHash('sha256').update(JSON.stringify(proposal)).digest('hex')
  return proposal
}
export function applyPauseEdit(project,proposal,{allowUnmatchedSpeech=false}={}) {
  if(proposal.projectId!==project.id||proposal.baseRevision!==project.revision)fail('REVISION_CONFLICT','剪辑建议已过期，请重新预览。',409)
  const fresh=proposePauseEdit(project,proposal.request)
  if(fresh.id!==proposal.id)fail('INVALID_EDIT','剪辑建议与当前作品不一致。')
  if(fresh.requiresConfirmation&&!allowUnmatchedSpeech)fail('CONFIRMATION_REQUIRED','请先试听并确认是否删除这段额外发声。',409)
  const p=clone(project)
  for(const cut of fresh.cuts)p.edits.push({id:randomUUID(),...cut,reason:'shorten_pause',allowUnmatchedSpeech})
  p.edits.sort((a,b)=>a.start-b.start)
  return p
}
export function compileTimeline(project) {
  if(!project.scenes.length||!project.recordingAssetId||!project.alignment)fail('NOT_READY','请准备图片、完整配音，并完成录音对应。')
  const alignment=validateAlignment(project,project.alignment)
  const unresolved=alignment.utterances.filter(u=>u.start===null)
  if(unresolved.length)fail('ALIGNMENT_REVIEW_REQUIRED',`还有${unresolved.length}句对白未找到录音位置，请先核对。`,409)
  const assets=new Map(project.assets.map(a=>[a.id,a])),author=new Map(dialogue(project).map(d=>[d.id,d]))
  if(!assets.has(project.recordingAssetId))fail('UNKNOWN_RECORDING','录音素材不存在。')
  for(const s of project.scenes)if(!s.imageAssetId||assets.get(s.imageAssetId)?.kind!=='image')fail('MISSING_IMAGE','每一幕都需要图片。')
  const cuts=checkedCuts(project),warnings=[]
  if(alignment.utterances.some(u=>u.matchStatus!=='matched'))warnings.push({code:'ALIGNMENT_NEEDS_REVIEW',message:'部分台词的对应位置需要试听确认。'})
  if(alignment.unmatchedSpeech.length)warnings.push({code:'UNMATCHED_SPEECH_RETAINED',message:'未对应的发声仍保留在录音里。'})
  const spoken=project.scenes.map((s,index)=>({scene:s,index,lines:alignment.utterances.filter(u=>u.sceneId===s.id)})).filter(s=>s.lines.length)
  if(!spoken.length)fail('ALIGNMENT_REQUIRED','至少需要一句已对应对白；纯无对白作品请使用后续专用模式。')
  const bounds=[0]
  for(let i=1;i<spoken.length;i++)bounds.push(snap((spoken[i-1].lines.at(-1).end+spoken[i].lines[0].start)/2))
  bounds.push(alignment.duration)
  const sourceRanges=new Map(spoken.map((s,i)=>[s.scene.id,{start:bounds[i],end:bounds[i+1]}]))
  const style=project.style
  const introNarration=style.narrationAssetId?assets.get(style.narrationAssetId):null
  const introSeconds=Math.max(style.introSeconds,introNarration?(introNarration.metadata.duration||0)+.65:0)
  let cursor=snap(introSeconds);const cues=[],subtitles=[],audioSegments=[],audioOverlays=[]
  if(introNarration)audioOverlays.push({assetId:introNarration.id,start:.3,gainDb:-3})
  let previousImage=null
  for(const scene of project.scenes){
    const range=sourceRanges.get(scene.id)
    if(scene.transition!=='cut'){
      const duration=scene.transition==='magic'?.8:2.2
      cues.push({id:'transition-'+scene.id,sceneId:scene.id,imageAssetId:scene.imageAssetId,fromAssetId:previousImage,start:cursor,end:snap(cursor+duration),kind:scene.transition,timeLabel:scene.timeLabel||'过了一会儿'})
      const soundId=scene.transition==='magic'?style.travelSoundAssetId:style.timeSoundAssetId
      if(soundId){const sound=assets.get(soundId);if(!sound)fail('UNKNOWN_AUDIO','过场音效不存在。');audioOverlays.push({assetId:soundId,start:cursor,gainDb:scene.transition==='magic'?-7:-12,maxDuration:duration})}
      cursor=snap(cursor+duration)
    }
    const sceneStart=cursor
    if(range){
      for(const r of retainedRanges(range.start,range.end,cuts)){audioSegments.push({...r,start:cursor});cursor=snap(cursor+r.sourceEnd-r.sourceStart)}
      for(const u of alignment.utterances.filter(u=>u.sceneId===scene.id)){
        const d=author.get(u.dialogueId)
        subtitles.push({id:u.id,dialogueId:d.id,sceneId:scene.id,characterId:d.characterId,text:d.text,mode:d.mode,start:snap(sceneStart+retainedDuration(range.start,u.start,cuts)),end:snap(sceneStart+retainedDuration(range.start,u.end,cuts))})
      }
    }else cursor=snap(cursor+2)
    if(cursor<=sceneStart)fail('INVALID_EDIT','不能删除整幕画面。')
    cues.push({id:'scene-'+scene.id,sceneId:scene.id,imageAssetId:scene.imageAssetId,start:sceneStart,end:cursor,kind:'scene',timeLabel:''})
    previousImage=scene.imageAssetId
  }
  return {width:style.width,height:style.height,fps:style.fps,duration:snap(cursor+style.outroSeconds),sampleRate:RATE,title:project.title,credits:clone(project.credits),characters:clone(project.characters),cues,subtitles,audioSegments,audioOverlays,introSeconds,outroSeconds:style.outroSeconds,warnings}
}
