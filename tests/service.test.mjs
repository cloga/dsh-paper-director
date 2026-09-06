import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,rm,readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { PaperDirectorCore } from '../src/core/service.js'
import { ProjectStore } from '../src/core/store.js'

const run=promisify(execFile)
const local=path.resolve(process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python')
const python=process.env.PAPER_DIRECTOR_TEST_PYTHON||(existsSync(local)?local:undefined)
const is=code=>e=>e.code===code
const fakeHealth={ready:true,cjkReady:true,dependencies:{av:true,numpy:true,Pillow:true},codecs:{libx264:true,aac:true},modelReady:false}
async function tempCore(fn,options={}){const root=await mkdtemp(path.join(tmpdir(),'paper-service-'));const worker=options.worker||{async run(){return fakeHealth},async close(){}};const core=new PaperDirectorCore({dataDir:root,...options.config},{worker,...options.dependencies});try{await core.init();await fn(core,root)}finally{await core.close();await rm(root,{recursive:true,force:true})}}
async function settle(core,id){const until=Date.now()+45000;for(;;){const j=await core.dispatch('job.get',{jobId:id});if(['succeeded','failed','cancelled','interrupted'].includes(j.status))return j;if(Date.now()>until)throw new Error('Job wait timed out');await delay(25)}}
function wav(seconds=4,rate=48000){const samples=Math.round(seconds*rate),b=Buffer.alloc(44+samples*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples*2,40);for(let i=0;i<samples;i++){const t=i/rate;const gate=t<.9||t>2.6?.08:0;b.writeInt16LE(Math.round(Math.sin(t*2*Math.PI*330)*gate*32767),44+i*2)}return b}

test('core denies cross-project scopes, persists trusted bindings, and requires human Agent starter',()=>tempCore(async(core)=>{
 const a=await core.dispatch('project.create',{title:'匿名作品'}),b=await core.dispatch('project.create',{title:'另一个项目'})
 await core.bindSession('session-a',a.id)
 assert.equal(await core.bindingForSession('session-a'),a.id)
 await assert.rejects(core.bindSession('session-a',b.id),is('BINDING_EXISTS'))
 await assert.rejects(core.dispatch('project.get',{projectId:b.id},{projectId:a.id}),is('PROJECT_FORBIDDEN'))
 await assert.rejects(core.dispatch('project.list',{}, {projectId:a.id}),is('PROJECT_FORBIDDEN'))
 await assert.rejects(core.dispatch('agent.start',{projectId:a.id,expectedRevision:1,prompt:'hi'},{projectId:a.id}),is('UNKNOWN_OPERATION'))
 await assert.rejects(core.startAgent({projectId:a.id,expectedRevision:1,prompt:'制作'}),is('AGENT_NOT_READY'))
 let called;core.setAgentStarter(async args=>{called=args;return {sessionId:'session-made'}})
 assert.deepEqual(await core.startAgent({projectId:a.id,expectedRevision:1,prompt:'制作'}),{sessionId:'session-made'})
 assert.equal(called.projectId,a.id)
 const h=await core.health();assert.equal(h.render.ready,true);assert.equal(h.narration.configured,false)
 await core.close();await core.close()
}))

test('exclusive store lease protects live jobs from another process owner',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'paper-lease-'));const a=await new ProjectStore({dataDir:root}).init(),b=new ProjectStore({dataDir:root})
 try{const p=await a.create();const j=await a.jobCreate(p.id,'render',1);await a.jobUpdate(j.id,{status:'running'});await assert.rejects(b.init(),is('STORE_IN_USE'));assert.equal((await a.jobGet(j.id)).status,'running');a.close();await b.init();assert.equal((await b.jobGet(j.id)).status,'interrupted')}finally{a.close();b.close();await rm(root,{recursive:true,force:true})}
})

test('concurrent identical jobs have one persisted execution and cancellation settles',()=>tempCore(async(core)=>{
 const p=await core.dispatch('project.create',{})
 const [a,b]=await Promise.all([core.enqueue(p,'unsupported',{}),core.enqueue(p,'unsupported',{})])
 assert.equal(a.id,b.id)
 const done=await settle(core,a.id);assert.equal(done.status,'failed')
 assert.equal((await core.dispatch('job.list',{projectId:p.id})).length,1)
 await assert.rejects(core.dispatch('narration.generate',{projectId:p.id,expectedRevision:1,text:'旁白'}),is('TTS_DISABLED'))
}))

test('late alignment result never overwrites newer author edits',async()=>{
 let finish,started
 const began=new Promise(r=>started=r)
 const worker={async run(request){if(request.action==='align'){started();return new Promise(r=>finish=r)}return fakeHealth},async close(){}}
 await tempCore(async(core)=>{
  let p=await core.store.create();const a=await core.store.addAsset(p.id,p.revision,{name:'recording.wav',kind:'audio',mime:'audio/wav',buffer:wav(),metadata:{duration:4,sampleRate:48000,channels:1}});p=a.project
  p=await core.store.update(p.id,p.revision,{recordingAssetId:a.asset.id,scenes:[{id:'scene',imageAssetId:null,dialogue:[{id:'line',characterId:'hero',text:'Hello'}]}]})
  const job=await core.dispatch('recording.align',{projectId:p.id,expectedRevision:p.revision,engine:'segments',segments:[]})
  await began
  const newer=await core.store.update(p.id,p.revision,{title:'作者的新标题'})
  finish({duration:4,utterances:[{dialogueId:'line',start:.2,end:.8,matchStatus:'matched',recognizedText:'Hello'}],speechRanges:[],unmatchedSpeech:[],method:'provided_segments'})
  const result=await settle(core,job.id);assert.equal(result.status,'succeeded');assert.equal(result.result.applied,false)
  const saved=await core.store.get(p.id);assert.equal(saved.title,newer.title);assert.equal(saved.alignment,null)
 },{worker})
})

test('real Node service imports, aligns, renders, edits and re-renders anonymous media',{skip:!python?'Prepare .venv or PAPER_DIRECTOR_TEST_PYTHON':false},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'paper-e2e-'));const core=new PaperDirectorCore({dataDir:path.join(root,'data'),pythonPath:python})
 try{
  await core.init();const h=await core.health();assert.equal(h.render.ready,true)
  const png=path.join(root,'anonymous.png')
  await run(python,['-I','-c','from PIL import Image,ImageDraw;import sys;im=Image.new("RGB",(320,240),"#fff0cb");d=ImageDraw.Draw(im);d.ellipse((100,30,210,140),fill="#ea99ab");d.polygon([(130,130),(70,230),(250,230)],fill="#74b6ad");im.save(sys.argv[1])',png])
  let p=await core.dispatch('project.create',{title:'匿名纸偶演示'})
  const picture=await core.importAsset(p.id,p.revision,{name:'画面.png',kind:'image',buffer:await readFile(png)});p=picture.project
  const recording=await core.importAsset(p.id,p.revision,{name:'recording.mp3_tmp',kind:'audio',buffer:wav()});p=recording.project
  p=await core.dispatch('project.update',{projectId:p.id,expectedRevision:p.revision,patch:{recordingAssetId:recording.asset.id,style:{width:640,height:480,fps:25,introSeconds:.5,outroSeconds:.5},scenes:[
    {id:'s1',imageAssetId:picture.asset.id,dialogue:[{id:'d1',characterId:'hero',text:'你好，小星星。'}],transition:'cut'},
    {id:'s2',imageAssetId:picture.asset.id,dialogue:[{id:'d2',characterId:'friend',text:'我们出发。'}],transition:'magic'}]}})
  const align=await core.dispatch('recording.align',{projectId:p.id,expectedRevision:p.revision,engine:'segments',segments:[{start:.2,end:.8,text:'你好，小星星。',dialogueId:'d1'},{start:2.6,end:3.3,text:'我们出发。',dialogueId:'d2'}]})
  let j=await settle(core,align.id);assert.equal(j.status,'succeeded',JSON.stringify(j.error));assert.equal(j.result.applied,true)
  p=await core.store.get(p.id)
  const render=await core.dispatch('movie.render',{projectId:p.id,expectedRevision:p.revision,preview:true})
  j=await settle(core,render.id);assert.equal(j.status,'succeeded',JSON.stringify(j.error));assert.equal(j.result.applied,true)
  const video=await core.asset(p.id,j.result.assetId);assert.equal(video.mime,'video/mp4');assert.ok(video.bytes>1000)
  p=await core.store.get(p.id)
  const before=p.revision
  const edit={projectId:p.id,expectedRevision:p.revision,operation:{type:'shorten_pause',afterDialogueId:'d1',beforeDialogueId:'d2',targetSeconds:.6}}
  await assert.rejects(core.dispatch('timeline.apply',edit),is('CONFIRMATION_REQUIRED'))
  p=await core.dispatch('timeline.apply',{...edit,allowUnmatchedSpeech:true})
  assert.ok(p.revision>before)
  const revised=await core.dispatch('movie.render',{projectId:p.id,expectedRevision:p.revision})
  j=await settle(core,revised.id);assert.equal(j.status,'succeeded',JSON.stringify(j.error))
  const second=await core.asset(p.id,j.result.assetId);assert.ok(second.metadata.duration<video.metadata.duration)
  assert.ok(!JSON.stringify(await core.dispatch('job.get',{jobId:revised.id})).includes(root))
 }finally{await core.close();await rm(root,{recursive:true,force:true})}
})
