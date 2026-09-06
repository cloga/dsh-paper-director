import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ProjectStore } from '../src/core/store.js'
import { newProject, normalizeAuthorPatch } from '../src/core/model.js'
import { validateAlignment, compileTimeline, proposePauseEdit, applyPauseEdit } from '../src/core/timeline.js'

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S3sAAAAASUVORK5CYII=','base64')
const rejects=(code)=>e=>e.code===code
async function withStore(fn){const root=await mkdtemp(path.join(tmpdir(),'paper-director-'));let store;try{store=await new ProjectStore({dataDir:root}).init();await fn(store,root)}finally{store?.close();await rm(root,{recursive:true,force:true})}}

test('persistent revisions, optimistic concurrency, restore and rollback',async()=>withStore(async(store,root)=>{
  const a=await store.create({title:'匿名演示',credits:{director:'小作者',voice:'小作者'}})
  assert.equal(a.revision,1)
  const b=await store.update(a.id,1,{story:'一个自己画的小故事'})
  assert.equal(b.revision,2)
  await assert.rejects(store.update(a.id,1,{title:'stale'}),rejects('REVISION_CONFLICT'))
  await assert.rejects(store.mutate(a.id,2,()=>{throw new Error('rollback')}),/rollback/)
  assert.equal((await store.get(a.id)).revision,2)
  const c=await store.restore(a.id,2,1);assert.equal(c.revision,3);assert.equal(c.story,'')
  assert.equal((await store.history(a.id)).length,3)
  store.close();await store.init();assert.equal((await store.get(a.id)).revision,3)
  assert.ok(!JSON.stringify(await store.get(a.id)).includes(root))
}))

test('assets are immutable, project-scoped and type checked',async()=>withStore(async(store)=>{
  const a=await store.create(),b=await store.create()
  const result=await store.addAsset(a.id,1,{name:'../picture.png',kind:'image',mime:'image/png',buffer:png,metadata:{width:1,height:1}})
  assert.equal(result.project.revision,2);assert.equal(result.asset.name,'.._picture.png')
  assert.equal((await store.asset(a.id,result.asset.id)).bytes,png.length)
  await assert.rejects(store.asset(b.id,result.asset.id),rejects('ASSET_NOT_FOUND'))
  await assert.rejects(store.get('../outside'),rejects('INVALID_ID'))
  await assert.rejects(store.addAsset(b.id,1,{name:'x.svg',kind:'image',mime:'image/svg+xml',buffer:Buffer.from('<svg/>')}),rejects('UNSUPPORTED_MEDIA'))
  await assert.rejects(store.addAsset(b.id,1,{name:'x.png',kind:'image',mime:'image/png',buffer:Buffer.from('not a png')}),rejects('MEDIA_TYPE_MISMATCH'))
  await assert.rejects(store.update(b.id,1,{scenes:[{id:'s',imageAssetId:result.asset.id,dialogue:[]}]}),rejects('UNKNOWN_IMAGE'))
  await assert.rejects(store.update(a.id,2,{assets:[]}),rejects('UNKNOWN_FIELD'))
}))

test('unfinished durable jobs are interrupted instead of silently rerun',async()=>withStore(async(store)=>{
  const p=await store.create();const job=await store.jobCreate(p.id,'render',1)
  await store.jobUpdate(job.id,{status:'running',progress:.4})
  store.close();await store.init()
  assert.equal((await store.jobGet(job.id)).status,'interrupted')
}))

function fixture(){
  const p=newProject({title:'星星旅行'})
  p.assets=[{id:'a',kind:'image',metadata:{}},{id:'b',kind:'image',metadata:{}},{id:'recording',kind:'audio',metadata:{duration:10}}]
  p.recordingAssetId='recording'
  p.scenes=[{id:'s1',imageAssetId:'a',action:'发现星星',dialogue:[{id:'d1',characterId:'hero',text:'你好，星星。',mode:'normal'}],transition:'cut',timeLabel:''},
    {id:'s2',imageAssetId:'b',action:'到达另一页',dialogue:[{id:'d2',characterId:'friend',text:'我们到了。',mode:'normal'}],transition:'magic',timeLabel:''}]
  p.alignment=validateAlignment(p,{duration:10,method:'provided',utterances:[{id:'u1',dialogueId:'d1',start:.5,end:2,recognizedText:'你好星星',matchStatus:'matched'},
    {id:'u2',dialogueId:'d2',start:6,end:7,recognizedText:'我们到了',matchStatus:'matched'}],speechRanges:[{start:.5,end:2},{start:6,end:7}],unmatchedSpeech:[]})
  return p
}

test('compile preserves recording and inserts an actual magic interval',()=>{
  const p=fixture(),timeline=compileTimeline(p)
  assert.equal(timeline.duration,17.8)
  assert.equal(timeline.cues.filter(c=>c.kind==='magic').length,1)
  assert.equal(timeline.subtitles[1].start,9.8)
  assert.equal(timeline.audioSegments.reduce((n,s)=>n+s.sourceEnd-s.sourceStart,0),10)
  assert.equal(timeline.subtitles[0].text,'你好，星星。')
})

test('pause edits ripple all later media and do not change author text',()=>{
  const p=fixture(),before=compileTimeline(p)
  const proposal=proposePauseEdit(p,{afterDialogueId:'d1',beforeDialogueId:'d2',targetSeconds:1})
  assert.equal(proposal.removedSeconds,3);assert.equal(proposal.requiresConfirmation,false)
  const next=applyPauseEdit(p,proposal),after=compileTimeline(next)
  assert.equal(after.duration,before.duration-3)
  assert.ok(Math.abs(after.subtitles[1].start-(before.subtitles[1].start-3)) < 1/48000)
  assert.deepEqual(next.scenes,p.scenes)
  assert.equal(proposePauseEdit(next,proposal.request).removedSeconds,0)
})

test('unmatched speech requires explicit confirmation',()=>{
  const p=fixture();p.alignment.unmatchedSpeech=[{start:3,end:4,text:'unclear sound'}]
  const proposal=proposePauseEdit(p,{afterDialogueId:'d1',beforeDialogueId:'d2',targetSeconds:1})
  assert.equal(proposal.requiresConfirmation,true)
  assert.throws(()=>applyPauseEdit(p,proposal),rejects('CONFIRMATION_REQUIRED'))
  assert.equal(applyPauseEdit(p,proposal,{allowUnmatchedSpeech:true}).edits.length,1)
  assert.throws(()=>applyPauseEdit({...p,revision:2},proposal,{allowUnmatchedSpeech:true}),rejects('REVISION_CONFLICT'))
})

test('author-supplied identities prevail and missing dialogue is not fabricated',()=>{
  const p=fixture();const a=validateAlignment(p,{duration:10,utterances:[{dialogueId:'d1',start:1,end:2,characterId:'wrong',recognizedText:'different spelling',matchStatus:'needs_review'}]})
  assert.equal(a.utterances[0].characterId,'hero');assert.equal(a.utterances[0].recognizedText,'different spelling')
  assert.equal(a.utterances[1].matchStatus,'unmatched');assert.equal(a.utterances[1].start,null)
  assert.throws(()=>compileTimeline({...p,alignment:a}),rejects('ALIGNMENT_REVIEW_REQUIRED'))
  assert.throws(()=>validateAlignment(p,{duration:10,utterances:[{dialogueId:'d1',sceneId:'s2',start:1,end:2}]}),rejects('INVALID_ALIGNMENT'))
})

test('silent action images remain visible without losing source audio',()=>{
  const p=fixture();p.scenes.splice(1,0,{id:'action',imageAssetId:'a',action:'按一下按钮',dialogue:[],transition:'cut',timeLabel:''})
  const t=compileTimeline(p)
  assert.equal(t.cues.filter(c=>c.kind==='scene').length,3)
  assert.equal(t.duration,19.8)
  assert.equal(t.audioSegments.reduce((n,s)=>n+s.sourceEnd-s.sourceStart,0),10)
})

test('presentation edits preserve timing, changed dialogue invalidates it',()=>{
  const p=fixture()
  const characters=p.characters.map(c=>({...c,name:c.name+'新版'}))
  const scenes=p.scenes.map(s=>({...s,action:'新的动作说明'}))
  const cosmetic=normalizeAuthorPatch(p,{characters,scenes})
  assert.deepEqual(cosmetic.alignment,p.alignment)
  const changed=normalizeAuthorPatch(p,{scenes:p.scenes.map((s,i)=>i? s:{...s,dialogue:s.dialogue.map(d=>({...d,text:'新台词'}))})})
  assert.equal(changed.alignment,null)
})

test('renderer refuses tampered speech deletion even if edit claims approval',()=>{
  const p=fixture();p.edits=[{id:'bad',start:1,end:1.5,allowUnmatchedSpeech:true}]
  assert.throws(()=>compileTimeline(p),rejects('SPEECH_PROTECTED'))
})
