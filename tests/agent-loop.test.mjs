import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,rm,mkdir,writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { PaperDirectorCore } from '../src/core/service.js'
import { validateAlignment } from '../src/core/timeline.js'
import { demoPng,demoWav,demoScenes } from '../scripts/demo-media.mjs'

const is=code=>error=>error.code===code
function aligned(){return {duration:4,method:'local_vosk',utterances:[{dialogueId:'line-one',start:.2,end:.8,matchStatus:'matched',recognizedText:'你好小星星'},{dialogueId:'line-two',start:2.6,end:3.3,matchStatus:'matched',recognizedText:'我们出发'}],speechRanges:[{start:.2,end:.8},{start:2.6,end:3.3}],unmatchedSpeech:[]}}
function worker(){return {async run(request){if(request.action==='align')return aligned();if(request.action==='render'){await mkdir(request.outputDir,{recursive:true});const bytes=Buffer.alloc(64);bytes.writeUInt32BE(24);bytes.write('ftypisom',4);await writeFile(path.join(request.outputDir,'movie.mp4'),bytes);return {path:'movie.mp4',warnings:[]}}throw new Error('Unexpected fixture action')},async close(){}}}
async function fixture(fn){const root=await mkdtemp(path.join(tmpdir(),'paper-agent-loop-'));const core=new PaperDirectorCore({dataDir:root,asrEngine:'vosk',asrModelPath:'fixture-only-not-loaded'},{worker:worker()});try{await core.init();let p=await core.store.create();const image=await core.store.addAsset(p.id,p.revision,{name:'generated.png',kind:'image',mime:'image/png',buffer:demoPng()});p=image.project;const recording=await core.store.addAsset(p.id,p.revision,{name:'tones.wav',kind:'audio',mime:'audio/wav',buffer:demoWav(),metadata:{duration:4}});p=recording.project;p=await core.store.update(p.id,p.revision,{recordingAssetId:recording.asset.id,scenes:demoScenes(image.asset.id)});await fn(core,p,root)}finally{await core.close();await rm(root,{recursive:true,force:true})}}
async function terminal(core,jobId){for(let i=0;i<400;i++){const j=await core.dispatch('job.get',{jobId});if(['succeeded','failed','cancelled','interrupted'].includes(j.status)){await Promise.allSettled([...core.active.values()]);await core.agentLoop.draining;return j}await delay(5)}throw new Error('Fixture job did not finish')}
async function setAligned(core,p){return core.store.mutate(p.id,p.revision,p=>{p.alignment=validateAlignment(p,aligned());return p})}

test('instant jobs subscribe before execution, notify once and continue into one render',()=>fixture(async(core,p)=>{
 await core.bindSession('studio-one',p.id);const notices=[];let renderJob
 const unsubscribe=core.onAgentNotice(async notice=>{notices.push(notice);if(notice.kind==='align'&&notice.status==='succeeded'){const latest=await core.dispatch('project.get',{}, {projectId:p.id,sessionId:'studio-one'});renderJob=await core.dispatch('movie.render',{expectedRevision:latest.revision,preview:true},{projectId:p.id,sessionId:'studio-one'})}return {delivery:'queued'}})
 const align=await core.dispatch('recording.align',{expectedRevision:p.revision},{projectId:p.id,sessionId:'studio-one'})
 await terminal(core,align.id);assert.ok(renderJob)
 const done=await terminal(core,renderJob.id);assert.equal(done.status,'succeeded');assert.equal(notices.length,1);assert.equal(notices[0].sessionId,'studio-one')
 core.agentLoop.settled(core.store.jobRead(align.id));await core.agentLoop.draining;assert.equal(notices.length,1)
 assert.ok(!('timelineIndex' in done.result));assert.ok(core.store.jobRead(renderJob.id).result.timelineIndex)
 unsubscribe();assert.equal(core.agentLoop.notifier,undefined)
}))

test('same-project subscribers share a job, foreign/admin scopes cannot subscribe',()=>fixture(async(core,p)=>{
 await core.bindSession('studio-one',p.id);await core.bindSession('studio-two',p.id)
 const other=await core.store.create();await core.bindSession('foreign-studio',other.id)
 await assert.rejects(core.dispatch('recording.align',{expectedRevision:p.revision},{projectId:p.id,sessionId:'foreign-studio'}),is('PROJECT_FORBIDDEN'))
 const notices=[];core.onAgentNotice(async n=>{notices.push(n);return {delivery:'queued'}})
 const [a,b]=await Promise.all([core.dispatch('recording.align',{expectedRevision:p.revision},{projectId:p.id,sessionId:'studio-one'}),core.dispatch('recording.align',{expectedRevision:p.revision},{projectId:p.id,sessionId:'studio-two'})])
 assert.equal(a.id,b.id);await terminal(core,a.id);assert.deepEqual(notices.map(n=>n.sessionId).sort(),['studio-one','studio-two'])
 p=await core.store.get(p.id)
 const admin=await core.dispatch('recording.align',{expectedRevision:p.revision},{projectId:p.id});await terminal(core,admin.id);assert.equal(notices.length,2)
}))

test('persisted proposal approval is atomic and wakes the authoring Agent with approved status',()=>fixture(async(core,p)=>{
 p=await setAligned(core,p);await core.bindSession('studio-one',p.id)
 const notices=[];core.onAgentNotice(async n=>{notices.push(n);return {delivery:'queued'}})
 const request={expectedRevision:p.revision,operation:{type:'shorten_pause',afterDialogueId:'line-one',beforeDialogueId:'line-two',targetSeconds:.6}}
 await assert.rejects(core.dispatch('timeline.apply',request,{projectId:p.id,sessionId:'studio-one'}),is('CONFIRMATION_REQUIRED'))
 const review=await core.review(p.id);assert.equal(review.proposals.length,1)
 const proposal=review.proposals[0];assert.ok(proposal.sourceRange.start<.8&&proposal.sourceRange.end>2.6)
 const other=await core.store.create();await assert.rejects(core.decideReview(other.id,proposal.id,{expectedRevision:p.revision,decision:'apply'}),is('REVIEW_NOT_FOUND'))
 const changed=await core.decideReview(p.id,proposal.id,{expectedRevision:p.revision,decision:'apply'});await core.agentLoop.draining
 assert.equal(changed.revision,p.revision+1);assert.equal((await core.review(p.id)).proposals.length,0)
 assert.deepEqual(notices.map(n=>[n.kind,n.status]),[['review','approved']])
 await assert.rejects(core.decideReview(p.id,proposal.id,{expectedRevision:p.revision,decision:'apply'}),is('REVISION_CONFLICT'))
}))

test('dismiss preserves content and stale approvals cannot alter a newer revision',()=>fixture(async(core,p)=>{
 p=await setAligned(core,p);await core.bindSession('studio-one',p.id)
 const notices=[];core.onAgentNotice(async n=>{notices.push(n);return {delivery:'queued'}})
 const request={expectedRevision:p.revision,operation:{type:'shorten_pause',afterDialogueId:'line-one',beforeDialogueId:'line-two',targetSeconds:.7}}
 const proposal=await core.dispatch('timeline.propose',request,{projectId:p.id,sessionId:'studio-one'})
 const original=await core.decideReview(p.id,proposal.id,{expectedRevision:p.revision,decision:'dismiss'});await core.agentLoop.draining
 assert.equal(original.revision,p.revision);assert.equal(original.edits.length,0);assert.equal(notices[0].status,'dismissed')
 request.operation.targetSeconds=.8
 const stale=await core.dispatch('timeline.propose',request,{projectId:p.id,sessionId:'studio-one'})
 const latest=await core.store.update(p.id,p.revision,{title:'作者已修改'})
 await assert.rejects(core.decideReview(p.id,stale.id,{expectedRevision:p.revision,decision:'apply'}),is('REVISION_CONFLICT'))
 assert.equal((await core.store.get(p.id)).revision,latest.revision)
}))

test('movie locate uses persisted rendered time rather than the current edited script',()=>fixture(async(core,p)=>{
 p=await setAligned(core,p)
 const job=await core.dispatch('movie.render',{projectId:p.id,expectedRevision:p.revision});const done=await terminal(core,job.id)
 const raw=core.store.jobRead(job.id),indexed=raw.result.timelineIndex.subtitles[1]
 const at=await core.dispatch('movie.locate',{assetId:done.result.assetId,time:indexed.start+.01},{projectId:p.id})
 assert.equal(at.scene.id,'scene-two');assert.equal(at.stale,false);assert.ok(at.activeDialogueIds.includes('line-two'))
 p=await core.store.get(p.id);p=await core.store.update(p.id,p.revision,{scenes:p.scenes.map(s=>({...s,action:'新版本的动作'}))})
 const old=await core.dispatch('movie.locate',{assetId:done.result.assetId,time:indexed.start+.01},{projectId:p.id})
 assert.equal(old.stale,true);assert.notEqual(old.scene.action,'新版本的动作')
 const other=await core.store.create();await assert.rejects(core.dispatch('movie.locate',{assetId:done.result.assetId,time:1},{projectId:other.id}),is('ASSET_NOT_FOUND'))
 const end=await core.dispatch('movie.locate',{assetId:done.result.assetId,time:raw.result.timelineIndex.duration+.01},{projectId:p.id});assert.equal(end.kind,'outro')
}))

test('status only reads a studio binding, bounds text and survives close during inspection',()=>fixture(async(core,p)=>{
 let reads=0;core.setAgentStatusReader(async()=>{reads++;return {liveStatus:'idle',lastTurnReason:'SECRET',messages:[{id:'m',seq:1,text:'x'.repeat(10000),interrupted:false}],private:'not part of DTO'}})
 const empty=await core.review(p.id);assert.equal(empty.agent.sessionId,null);assert.equal(reads,0)
 await core.bindSession('studio-one',p.id);const review=await core.review(p.id);assert.equal(review.agent.messages[0].text.length,8000);assert.equal(review.agent.lastTurnReason,null);assert.ok(!('private' in review.agent))
 let release,entered;const waiting=new Promise(r=>entered=r)
 core.setAgentStatusReader(()=>{entered();return new Promise(r=>release=r)})
 const pending=core.review(p.id);await waiting;await core.close();release({liveStatus:'idle',messages:[]})
 await assert.rejects(pending,is('SERVICE_UNAVAILABLE'))
}))

test('cold/rejected notices are not blindly retried and closed callbacks are not invoked',()=>fixture(async(core,p)=>{
 p=await setAligned(core,p);await core.bindSession('studio-one',p.id)
 const notices=[];const off=core.onAgentNotice(async n=>{notices.push(n);return {delivery:'cold'}})
 const job=await core.enqueue(p,'align',{engine:'vosk'},'studio-one');await terminal(core,job.id)
 core.agentLoop.settled(core.store.jobRead(job.id));await core.agentLoop.draining;assert.equal(notices.length,1)
 off();core.agentLoop.queueNotice({id:'later',projectId:p.id,sessionId:'studio-one',kind:'review',status:'approved'});await core.close();await core.agentLoop.drain();assert.equal(notices.length,1)
}))

test('empty drain registration cannot strand a same-turn review notification',()=>fixture(async(core,p)=>{
 p=await setAligned(core,p);await core.bindSession('studio-one',p.id)
 const proposal=await core.dispatch('timeline.propose',{expectedRevision:p.revision,operation:{type:'shorten_pause',afterDialogueId:'line-one',beforeDialogueId:'line-two',targetSeconds:.6}},{projectId:p.id,sessionId:'studio-one'})
 const notices=[];core.onAgentNotice(async n=>{notices.push(n);return {delivery:'queued'}})
 await core.decideReview(p.id,proposal.id,{expectedRevision:p.revision,decision:'apply'})
 await core.agentLoop.draining
 assert.equal(notices.length,1);assert.equal(core.store.db.prepare("SELECT COUNT(*) AS n FROM paper_agent_notices WHERE delivery='pending'").get().n,0)
}))

test('an unapplied stale export never masquerades as the current movie',()=>fixture(async(core,p)=>{
 p=await setAligned(core,p);let release,entered
 const waiting=new Promise(r=>entered=r),gate=new Promise(r=>release=r),run=core.worker.run.bind(core.worker)
 core.worker.run=async request=>{if(request.action==='render'){entered();await gate}return run(request)}
 const job=await core.dispatch('movie.render',{projectId:p.id,expectedRevision:p.revision});await waiting
 await core.store.update(p.id,p.revision,{title:'作者已改了新版本'})
 release();const done=await terminal(core,job.id);assert.equal(done.result.applied,false)
 assert.equal((await core.store.get(p.id)).revision,done.result.revision)
 const location=await core.dispatch('movie.locate',{assetId:done.result.assetId,time:3.3},{projectId:p.id})
 assert.equal(location.stale,true)
}))

test('dismissed proposals are not silently offered again at the same revision',()=>fixture(async(core,p)=>{
 p=await setAligned(core,p);await core.bindSession('studio-one',p.id)
 const request={expectedRevision:p.revision,operation:{type:'shorten_pause',afterDialogueId:'line-one',beforeDialogueId:'line-two',targetSeconds:.6}}
 const proposal=await core.dispatch('timeline.propose',request,{projectId:p.id,sessionId:'studio-one'})
 await core.decideReview(p.id,proposal.id,{expectedRevision:p.revision,decision:'dismiss'})
 await assert.rejects(core.dispatch('timeline.propose',request,{projectId:p.id,sessionId:'studio-one'}),is('REVIEW_DISMISSED'))
}))
