#!/usr/bin/env node
// Source-checkout demonstration only. All images/audio are synthetic CC0 fixtures.
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { PaperDirectorCore } from '../src/core/service.js'
import { demoPng,demoWav,demoScenes,demoSegments } from './demo-media.mjs'

export async function waitJob(core,jobId){
  const deadline=Date.now()+120000
  for(;;){const job=await core.dispatch('job.get',{jobId});if(['succeeded','failed','cancelled','interrupted'].includes(job.status)){if(job.status!=='succeeded')throw new Error(JSON.stringify(job.error));return job}if(Date.now()>deadline)throw new Error('Demo job timed out');await delay(100)}
}
export async function createDemo(core){
  let project=await core.dispatch('project.create',{title:'纸偶的星星旅行',story:'纸偶发现星星，出发去另一页。此演示声音是音调，不是真人语音。',credits:{director:'匿名合成演示',voice:'音调（非真人）'}})
  const picture=await core.importAsset(project.id,project.revision,{name:'anonymous-puppet.png',kind:'image',buffer:demoPng()});project=picture.project
  const audio=await core.importAsset(project.id,project.revision,{name:'synthetic-recording.wav',kind:'audio',buffer:demoWav()});project=audio.project
  project=await core.dispatch('project.update',{projectId:project.id,expectedRevision:project.revision,patch:{recordingAssetId:audio.asset.id,style:{width:640,height:480,fps:25,introSeconds:1,outroSeconds:2},scenes:demoScenes(picture.asset.id)}})
  const alignment=await core.dispatch('recording.align',{projectId:project.id,expectedRevision:project.revision,engine:'segments',segments:demoSegments})
  await waitJob(core,alignment.id);project=await core.store.get(project.id)
  const first=await core.dispatch('movie.render',{projectId:project.id,expectedRevision:project.revision});const firstDone=await waitJob(core,first.id)
  project=await core.store.get(project.id)
  const change={type:'shorten_pause',afterDialogueId:'line-one',beforeDialogueId:'line-two',targetSeconds:.6}
  const proposal=await core.dispatch('timeline.propose',{projectId:project.id,expectedRevision:project.revision,operation:change})
  // The synthetic fixture has known silent samples. This is explicit human/test approval,
  // not a model bypass and not evidence of actual ASR silence detection.
  project=await core.dispatch('timeline.apply',{projectId:project.id,expectedRevision:project.revision,operation:change,allowUnmatchedSpeech:true})
  const second=await core.dispatch('movie.render',{projectId:project.id,expectedRevision:project.revision});const secondDone=await waitJob(core,second.id)
  const before=await core.asset(project.id,firstDone.result.assetId),after=await core.asset(project.id,secondDone.result.assetId)
  return {projectId:project.id,revision:(await core.store.get(project.id)).revision,before,after,removedSeconds:proposal.removedSeconds}
}
async function main(){
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
  const output=path.resolve(process.argv[2]||path.join(root,'.test-output','demo'))
  await fs.mkdir(output,{recursive:true})
  const pythonPath=process.env.PAPER_DIRECTOR_TEST_PYTHON||path.join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python')
  const core=new PaperDirectorCore({dataDir:path.join(output,'data'),pythonPath})
  try{
    await core.init();const demo=await createDemo(core)
    const movie=path.join(output,'paper-director-'+demo.projectId+'.mp4');await fs.copyFile(demo.after.path,movie)
    const report={origin:'Generated anonymous PNG and oscillator tones; CC0-1.0',speechClaim:'Provided markers only, not real speech or ASR-quality evidence',projectId:demo.projectId,revision:demo.revision,beforeSeconds:demo.before.metadata.duration,afterSeconds:demo.after.metadata.duration,removedSeconds:demo.removedSeconds,videoFile:path.basename(movie),videoSha256:demo.after.sha256}
    const evidence=path.join(output,'evidence-'+demo.projectId+'.json');await fs.writeFile(evidence,JSON.stringify(report,null,2),{flag:'wx'})
    console.log(JSON.stringify(report,null,2))
  }finally{await core.close()}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main()
