import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp,rm,mkdir,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { PaperDirectorCore } from '../src/core/service.js'
import { handleRequest } from '../src/http.js'
import { demoPng,demoWav,demoScenes,demoSegments } from '../scripts/demo-media.mjs'

const local=path.resolve(process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python')
const python=process.env.PAPER_DIRECTOR_TEST_PYTHON||(existsSync(local)?local:undefined)
const playwrightFile=new URL('./ui/.deps/node_modules/playwright/index.mjs',import.meta.url)
const hasBrowser=existsSync(playwrightFile)

test('real HTTP API and browser CSP upload, render, play, and ripple-edit a generated movie',{skip:!python||!hasBrowser?'Requires media Python and optional tests/ui Playwright installation':false,timeout:120000},async()=>{
 const {chromium}=await import(playwrightFile.href)
 const root=await mkdtemp(path.join(tmpdir(),'paper-http-e2e-')),core=new PaperDirectorCore({dataDir:path.join(root,'data'),pythonPath:python})
 let browser,server
 try{
  await core.init()
  // Isolated fixture only: tests application HTTP/media, not DSH cookie cryptography.
  server=createServer((req,res)=>{if(req.headers.cookie!=='paper-fixture=ok'){res.writeHead(401);res.end();return}handleRequest(core,req,res)})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const origin=`http://127.0.0.1:${server.address().port}`,base=origin+'/paper-director/api'
  const call=async(url,{method='GET',body,headers={}}={})=>{
   const response=await fetch(base+url,{method,headers:{Cookie:'paper-fixture=ok',Origin:origin,...(body!==undefined&&!Buffer.isBuffer(body)?{'Content-Type':'application/json'}:{}),...headers},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)})
   const json=await response.json();assert.equal(json.ok,true,JSON.stringify(json.error));return json.data
  }
  const wait=async(jobId)=>{for(let i=0;i<500;i++){const j=await call('/jobs/'+jobId);if(['failed','cancelled','interrupted'].includes(j.status))throw new Error(JSON.stringify(j.error));if(j.status==='succeeded')return j;await delay(50)}throw new Error('Job timeout')}
  let p=await call('/projects',{method:'POST',body:{title:'真实网页匿名演示',credits:{director:'匿名测试',voice:'合成音调，不是真人语音'}}})
  const upload=async(name,kind,buffer)=>call(`/projects/${p.id}/assets`,{method:'POST',body:buffer,headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(name),'X-Asset-Kind':kind,'X-Project-Revision':String(p.revision)}})
  const image=await upload('anonymous.png','image',demoPng());p=image.project
  const recording=await upload('synthetic.mp3_tmp','audio',demoWav());p=recording.project
  p=await call('/projects/'+p.id,{method:'PATCH',body:{expectedRevision:p.revision,patch:{recordingAssetId:recording.asset.id,style:{width:640,height:480,fps:25,introSeconds:1,outroSeconds:2},scenes:demoScenes(image.asset.id)}}})
  const aligned=await call(`/projects/${p.id}/align`,{method:'POST',body:{expectedRevision:p.revision,engine:'segments',segments:demoSegments}});await wait(aligned.id)
  p=await call('/projects/'+p.id)
  browser=await chromium.launch(process.platform==='win32'?{channel:'msedge',headless:true}:{headless:true})
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'})
  await context.addCookies([{name:'paper-fixture',value:'ok',url:origin}])
  await context.addInitScript(()=>{Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{const audio=new AudioContext(),oscillator=audio.createOscillator(),gain=audio.createGain(),destination=audio.createMediaStreamDestination();gain.gain.value=.04;oscillator.connect(gain);gain.connect(destination);oscillator.start();await audio.resume();window.syntheticAudio=audio;return destination.stream}})})
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message))
  page.on('console',message=>{if(message.type()==='error'&&/Content Security Policy/.test(message.text()))errors.push('CSP violation')})
  page.on('dialog',dialog=>dialog.message().startsWith('录一个新的完整版本')?dialog.accept():dialog.dismiss())
  await page.goto(origin+'/paper-director/',{waitUntil:'networkidle'})
  await page.locator('#projects button').filter({hasText:p.title}).click()
  await page.waitForFunction(()=>!document.getElementById('preview').disabled)
  await page.locator('#preview').click()
  await page.waitForFunction(()=>{const v=document.getElementById('movie-player');return !v.hidden&&v.readyState>=2&&v.videoWidth===640},{},{timeout:45000})
  const firstDuration=await page.locator('#movie-player').evaluate(v=>v.duration)
  await page.locator('#movie-player').evaluate(v=>{v.muted=true;return v.play()})
  await page.waitForFunction(()=>document.getElementById('movie-player').currentTime>.35)
  await page.locator('#movie-player').evaluate(v=>v.pause())
  assert.equal(errors.length,0)
  p=await call('/projects/'+p.id)
  const op={type:'shorten_pause',afterDialogueId:'line-one',beforeDialogueId:'line-two',targetSeconds:.6}
  const proposed=await call(`/projects/${p.id}/edits`,{method:'POST',body:{expectedRevision:p.revision,operation:op,apply:false}})
  assert.ok(proposed.requiresConfirmation)
  p=await call(`/projects/${p.id}/edits`,{method:'POST',body:{expectedRevision:p.revision,operation:op,apply:true,allowUnmatchedSpeech:true}})
  const revised=await call(`/projects/${p.id}/render`,{method:'POST',body:{expectedRevision:p.revision}});const final=await wait(revised.id)
  const video=await fetch(`${base}/projects/${p.id}/assets/${final.result.assetId}`,{headers:{Cookie:'paper-fixture=ok',Range:'bytes=0-31'}})
  assert.equal(video.status,206);assert.equal((await video.arrayBuffer()).byteLength,32)
  await page.reload({waitUntil:'networkidle'});await page.locator('#projects button').filter({hasText:p.title}).click()
  await page.waitForFunction(()=>{const v=document.getElementById('movie-player');return !v.hidden&&v.readyState>=2},{},{timeout:15000})
  const secondDuration=await page.locator('#movie-player').evaluate(v=>v.duration)
  assert.ok(Math.abs(firstDuration-secondDuration-1.2)<.05)
  await page.locator('#watch').scrollIntoViewIfNeeded()
  const out=path.resolve('tests/ui/.artifacts/real-http');await mkdir(out,{recursive:true})
  await page.screenshot({path:path.join(out,'movie.png')})
  // Exercise the actual MediaRecorder container through the real import/probe/render path.
  const oldRecording=p.recordingAssetId
  await page.locator('#start-recording').click();await page.waitForFunction(()=>!document.getElementById('stop-recording').hidden);await page.waitForTimeout(1100);await page.locator('#stop-recording').click()
  for(let i=0;i<200;i++){p=await call('/projects/'+p.id);if(p.recordingAssetId!==oldRecording)break;await delay(50)}
  assert.notEqual(p.recordingAssetId,oldRecording)
  const browserAudio=p.assets.find(a=>a.id===p.recordingAssetId);assert.ok(browserAudio.metadata.duration>.5)
  p=await call('/projects/'+p.id,{method:'PATCH',body:{expectedRevision:p.revision,patch:{scenes:[{id:'recorded-scene',imageAssetId:image.asset.id,dialogue:[{id:'recorded-line',characterId:'hero',text:'匿名音调'}]}],style:{introSeconds:.3,outroSeconds:.5}}}})
  const marked=await call(`/projects/${p.id}/align`,{method:'POST',body:{expectedRevision:p.revision,engine:'segments',segments:[{start:.1,end:.4,text:'匿名音调'}]}});await wait(marked.id)
  p=await call('/projects/'+p.id)
  const nativeRender=await call(`/projects/${p.id}/render`,{method:'POST',body:{expectedRevision:p.revision,preview:true}});const nativeDone=await wait(nativeRender.id);assert.ok(nativeDone.result.assetId)
  assert.equal(errors.length,0)
  await writeFile(path.join(out,'evidence.json'),JSON.stringify({origin:'Generated CC0 geometry and oscillator tones; explicit provided markers',transport:'Real loopback HTTP, no Playwright route mocks',auth:'Test fixture cookie; real DSH delegation is tested separately',model:'No live model turn',firstDuration,secondDuration,range:true,mediaRecorder:{mime:browserAudio.mime,duration:browserAudio.metadata.duration,rendered:true},browserErrors:errors},null,2))
  assert.equal((await fetch(origin+'/paper-director/')).status,401)
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}await core.close();await rm(root,{recursive:true,force:true})}
})
