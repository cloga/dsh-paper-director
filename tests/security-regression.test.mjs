import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,rm,writeFile,mkdir,stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { PaperDirectorCore } from '../src/core/service.js'
import { ProjectStore } from '../src/core/store.js'
import { ProjectError,probeMetadata,newProject,normalizeAuthorPatch } from '../src/core/model.js'
import { validateAlignment } from '../src/core/timeline.js'
import { publicError } from '../src/core/diagnostics.js'
import { safeMessage } from '../src/core/worker.js'
import { synthesizeNarration,inspectPcmWav } from '../src/core/tts.js'

const is=code=>error=>error.code===code
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S3sAAAAASUVORK5CYII=','base64')
function wav(){const b=Buffer.alloc(44+48000);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(48000,40);return b}
const header=()=>{const b=Buffer.alloc(64);b.writeUInt32BE(24,0);b.write('ftypisom',4);return b}
async function settle(core,id){for(let n=0;n<400;n++){const j=await core.dispatch('job.get',{jobId:id});if(['succeeded','failed','cancelled','interrupted'].includes(j.status))return j;await delay(5)}throw new Error('Job did not settle')}
async function useCore(fn,{config={},worker,tts}={}){const root=await mkdtemp(path.join(tmpdir(),'paper-security-'));const core=new PaperDirectorCore({dataDir:root,...config},{worker:worker||{async run(r){if(r.action==='render'){await mkdir(r.outputDir,{recursive:true});await writeFile(path.join(r.outputDir,'movie.mp4'),header());return {path:'movie.mp4',warnings:['Audio mix exceeded full scale; clipped samples: 4']}}throw new Error('Unexpected worker action')},async close(){}},...(tts?{tts}:{})});try{await core.init();await fn(core,root)}finally{await core.close();await rm(root,{recursive:true,force:true})}}
async function prepared(core){let p=await core.store.create();let a=await core.store.addAsset(p.id,p.revision,{name:'anonymous.png',kind:'image',mime:'image/png',buffer:png});p=a.project;const image=a.asset.id;a=await core.store.addAsset(p.id,p.revision,{name:'synthetic.wav',kind:'audio',mime:'audio/wav',buffer:wav(),metadata:{duration:1}});p=a.project;p=await core.store.update(p.id,p.revision,{recordingAssetId:a.asset.id,scenes:[{id:'scene',imageAssetId:image,dialogue:[{id:'line',characterId:'hero',text:'匿名'}]}]});return core.store.mutate(p.id,p.revision,p=>{p.alignment=validateAlignment(p,{duration:1,utterances:[{dialogueId:'line',start:.1,end:.5,recognizedText:'匿名',matchStatus:'matched'}],speechRanges:[],unmatchedSpeech:[],method:'provided_segments'});return p})}

test('restoring old revisions cannot reset the physical immutable asset quota',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'paper-quota-'));const s=await new ProjectStore({dataDir:root,maxProjectBytes:png.length+10}).init()
 try{let p=await s.create();p=(await s.addAsset(p.id,p.revision,{name:'a.png',kind:'image',mime:'image/png',buffer:png})).project;p=await s.restore(p.id,p.revision,1);assert.equal(p.assets.length,0);await assert.rejects(s.addAsset(p.id,p.revision,{name:'b.png',kind:'image',mime:'image/png',buffer:png}),is('PROJECT_QUOTA'));assert.equal(s.usage(p.id).count,1)}finally{s.close();await rm(root,{recursive:true,force:true})}
})

test('empty or forged scope is rejected before project/job lookup',()=>useCore(async(core)=>{
 const p=await core.store.create();await assert.rejects(core.dispatch('project.get',{projectId:p.id},{}),is('PROJECT_FORBIDDEN'));await assert.rejects(core.dispatch('job.get',{jobId:'secret'},{}),is('PROJECT_FORBIDDEN'));await assert.rejects(core.dispatch('project.get',{projectId:p.id},{projectId:p.id,admin:true}),is('PROJECT_FORBIDDEN'))
}))

test('snapshot-read failures settle jobs with a fixed safe diagnostic',()=>useCore(async(core)=>{
 const p=await core.store.create();const get=core.store.get.bind(core.store);core.store.get=(id,revision)=>revision!==undefined?Promise.reject(new Error('token=synthetic-secret /srv/private/movie.wav')):get(id)
 const j=await core.enqueue(p,'render',{});const done=await settle(core,j.id);assert.equal(done.status,'failed');assert.equal(done.error.code,'OPERATION_FAILED');assert.ok(!JSON.stringify(done).includes('/srv'));assert.ok(!JSON.stringify(done).includes('synthetic-secret'))
}))

test('cancel before atomic import prevents changes and removes temporary output',()=>useCore(async(core,root)=>{
 const p=await prepared(core);const add=core.store.addAsset.bind(core.store)
 core.store.addAsset=async(...args)=>{if(args[2].kind==='video')for(const c of core.controllers.values())c.abort();return add(...args)}
 const job=await core.dispatch('movie.render',{projectId:p.id,expectedRevision:p.revision});const done=await settle(core,job.id);assert.equal(done.status,'cancelled');assert.equal((await core.store.get(p.id)).revision,p.revision)
 await Promise.allSettled([...core.active.values()]);await assert.rejects(stat(path.join(root,'jobs',job.id)))
}))

test('cancel after atomic project/job commit is too late, never false-cancelled',()=>useCore(async(core,root)=>{
 const p=await prepared(core);const add=core.store.addAsset.bind(core.store)
 core.store.addAsset=async(...args)=>{const result=await add(...args);if(args[2].kind==='video')for(const c of core.controllers.values())c.abort();return result}
 const j=await core.dispatch('movie.render',{projectId:p.id,expectedRevision:p.revision});const done=await settle(core,j.id);assert.equal(done.status,'succeeded');assert.equal(done.result.applied,true);assert.equal((await core.store.get(p.id)).exports.length,1);assert.ok(done.result.warnings.some(w=>w.code==='AUDIO_CLIPPED'))
 await Promise.allSettled([...core.active.values()]);await assert.rejects(stat(path.join(root,'jobs',j.id)))
}))

test('huge derived output is rejected before reading/asset registration',()=>useCore(async(core)=>{
 const p=await prepared(core);core.config.maxAssetBytes=32;const j=await core.dispatch('movie.render',{projectId:p.id,expectedRevision:p.revision});const done=await settle(core,j.id);assert.equal(done.status,'failed');assert.equal(done.error.code,'OUTPUT_LIMIT');assert.equal((await core.store.get(p.id)).revision,p.revision)
}))

test('queue admission reserves slots before asynchronous work',()=>useCore(async(core)=>{
 const p=await core.store.create();let release;core.executeJob=()=>new Promise(r=>release=r)
 const requests=Array.from({length:40},(_,n)=>Promise.resolve().then(()=>core.enqueue(p,'hold',{n})))
 const results=await Promise.allSettled(requests);assert.equal(results.filter(r=>r.status==='fulfilled').length,30);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.code==='QUEUE_FULL').length,10);assert.equal((await core.store.jobs(p.id)).length,30)
 const closing=core.close();release();await closing
}))

test('job quota is persistent and transactional',()=>useCore(async(core)=>{
 const p=await core.store.create();const results=await Promise.allSettled(Array.from({length:8},(_,n)=>core.store.jobCreate(p.id,'render',p.revision,{fingerprint:'unique-'+n})));assert.equal(results.filter(r=>r.status==='fulfilled').length,2);assert.equal((await core.store.jobs(p.id)).length,2)
},{config:{maxJobsPerProject:2}}))

test('TTS post-success persistence failure cannot trigger a paid duplicate',async()=>{
 const key='PAPER_DIRECTOR_TEST_ONLY_KEY',old=process.env[key];process.env[key]='synthetic-test-not-a-real-credential';let calls=0
 try{await useCore(async(core)=>{
  const p=await core.store.create();core.store.addAsset=async()=>{throw new ProjectError('PROJECT_QUOTA','quota')}
  const j=await core.dispatch('narration.generate',{projectId:p.id,expectedRevision:p.revision,text:'匿名标题'});const done=await settle(core,j.id);assert.equal(done.status,'failed');assert.equal(done.error.code,'TTS_UNCERTAIN')
  await assert.rejects(core.dispatch('narration.generate',{projectId:p.id,expectedRevision:p.revision,text:'匿名标题'}),is('TTS_UNCERTAIN'));assert.equal(calls,1)
 },{config:{allowCloudTts:true,azureRegion:'eastus',azureKeyEnv:key},tts:async()=>{calls++;return {buffer:wav(),metadata:inspectPcmWav(wav()),voice:'zh-CN-XiaoxiaoNeural'}}})}finally{if(old===undefined)delete process.env[key];else process.env[key]=old}
})

test('generic and worker diagnostics cannot expose paths or key forms',()=>{
 for(const value of ['/srv/private/movie.wav','token=synthetic-secret','api_key: synthetic-secret','C:\\private\\file'])assert.ok(!safeMessage(value).includes('private')&&!safeMessage(value).includes('synthetic-secret'))
 assert.deepEqual(publicError(new Error('secret with no known prefix')),{code:'OPERATION_FAILED',message:'操作没有完成，请检查素材或联系家长。'})
})

test('metadata output limit and author character contracts match the renderer',()=>{
 assert.equal(probeMetadata({duration:850},{maxDuration:900}).duration,850)
 assert.throws(()=>probeMetadata({duration:850}),is('INVALID_NUMBER'))
 assert.throws(()=>normalizeAuthorPatch(newProject(),{characters:[{id:'narrator',name:'a',color:'#123456'}]}),is('RESERVED_CHARACTER'))
})

test('Azure transport is text-only, fixed-host, redirect-free, escaped and opt-in',async()=>{
 const key='PAPER_DIRECTOR_TRANSPORT_TEST',old=process.env[key];process.env[key]='synthetic-test-not-a-real-credential';let request,calls=0
 const config={allowCloudTts:true,azureRegion:'eastus',azureKeyEnv:key}
 try{
  await assert.rejects(synthesizeNarration({...config,allowCloudTts:false},'test',{fetchImpl:()=>{calls++}}),is('TTS_DISABLED'));assert.equal(calls,0)
  const result=await synthesizeNarration(config,'<匿名 & 标题>',{fetchImpl:async(url,options)=>{calls++;request={url,options};return new Response(wav(),{status:200})}})
  assert.equal(request.url,'https://eastus.tts.speech.microsoft.com/cognitiveservices/v1');assert.equal(request.options.redirect,'manual');assert.ok(request.options.body.includes('&lt;匿名 &amp; 标题&gt;'));assert.equal(result.metadata.duration,1)
  await assert.rejects(synthesizeNarration({...config,azureRegion:'evil.example/path'},'x',{fetchImpl:()=>{throw new Error('must not run')}}),is('TTS_DISABLED'))
  await assert.rejects(synthesizeNarration(config,'x',{fetchImpl:async()=>{throw new Error('token=synthetic-secret /tmp/private')}}),is('TTS_UNCERTAIN'))
 }finally{if(old===undefined)delete process.env[key];else process.env[key]=old}
})
