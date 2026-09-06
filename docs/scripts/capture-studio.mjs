// Documentation capture only: isolated local Core, generated media, no production
// cookies, passwords, model calls or microphone. Real application/API/rendering.
import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from '../../tests/ui/.deps/node_modules/playwright/index.mjs'
import { PaperDirectorCore } from '../../src/core/service.js'
import { handleRequest } from '../../src/http.js'
import { demoPng,demoWav } from '../../scripts/demo-media.mjs'

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const OUT=path.join(ROOT,'.test-output','docs-media'),MEDIA=path.join(ROOT,'docs','media')
await fs.mkdir(OUT,{recursive:true});await fs.mkdir(MEDIA,{recursive:true})
const temporary=await fs.mkdtemp(path.join(tmpdir(),'paper-docs-'))
const python=process.env.PAPER_DIRECTOR_TEST_PYTHON||path.join(ROOT,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python')
const core=new PaperDirectorCore({dataDir:path.join(temporary,'data'),pythonPath:python})
let server,browser
const captures=[]
try{
 await core.init()
 server=createServer((req,res)=>handleRequest(core,req,res))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const origin=`http://127.0.0.1:${server.address().port}`
 const api=async(url,method='GET',body)=>{const r=await fetch(origin+'/paper-director/api'+url,{method,headers:{Origin:origin,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const j=await r.json();if(!j.ok)throw new Error(JSON.stringify(j.error));return j.data}
 browser=await chromium.launch(process.platform==='win32'?{channel:'msedge',headless:true}:{headless:true})
 const context=await browser.newContext({viewport:{width:1000,height:700},deviceScaleFactor:1,locale:'zh-CN',reducedMotion:'reduce'})
 const page=await context.newPage(),errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 page.on('dialog',dialog=>dialog.accept()) // only intentional fixture actions, never real auth
 const view=async(selector)=>{await page.locator(selector).evaluate(el=>el.scrollIntoView({block:'start',behavior:'instant'}));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))}
 const capture=async(name,label,cursorLocator)=>{
   await page.evaluate(()=>document.fonts.ready)
   const image=path.join(OUT,name+'.png');await page.screenshot({path:image,fullPage:false,animations:'disabled'})
   const box=cursorLocator?await cursorLocator.boundingBox():null
   captures.push({name,label,image:name+'.png',cursor:box?[Math.round(box.x+box.width/2),Math.round(box.y+box.height/2)]:null})
 }
 await page.goto(origin+'/paper-director/',{waitUntil:'domcontentloaded'})
 await page.getByRole('button',{name:'＋ 开始一个新故事',exact:true}).click()
 await page.locator('#editor').waitFor({state:'visible'})
 await page.locator('#title').fill('星星的回家路')
 await page.locator('#story').fill('小纸偶发现一颗迷路的星星，和朋友一起送它回家。')
 await page.locator('#director').fill('演示小导演')
 await page.locator('#voice').fill('合成音调（非真人）')
 await page.evaluate(()=>scrollTo(0,120))
 await capture('01-idea','1 / 5  写下自己的故事与署名',page.locator('#save'))
 await page.locator('#save').click();await page.waitForFunction(()=>document.getElementById('save').disabled)
 await page.locator('#photo-files').setInputFiles([{name:'paper-puppet-01.png',mimeType:'image/png',buffer:demoPng()},{name:'paper-puppet-02.png',mimeType:'image/png',buffer:demoPng()}])
 await page.waitForFunction(()=>document.querySelectorAll('.scene').length===2&&document.getElementById('save').disabled)
 const scene0=page.locator('.scene').nth(0),scene1=page.locator('.scene').nth(1)
 await scene0.getByRole('button',{name:'＋ 加一句台词',exact:true}).click()
 await scene0.getByLabel('这里发生了什么动作？',{exact:true}).fill('小纸偶捧起一颗迷路的星星。')
 await scene0.getByLabel('这句台词',{exact:true}).fill('星星也想回家吗？')
 await scene0.getByLabel('怎么说').selectOption('thought')
 await scene1.getByRole('button',{name:'＋ 加一句台词',exact:true}).click()
 await scene1.getByLabel('这里发生了什么动作？',{exact:true}).fill('两位朋友穿过发光的门，一起出发。')
 await scene1.getByLabel('谁在说').selectOption('friend')
 await scene1.getByLabel('这句台词',{exact:true}).fill('走吧，我们一起送它回家！')
 await scene1.getByLabel('这一幕怎样登场').selectOption('magic')
 await page.locator('#save').click();await page.waitForFunction(()=>document.getElementById('save').disabled)
 await view('#photos');await capture('02-storyboard','2 / 5  每张照片写对白和动作',scene0.getByLabel('这句台词',{exact:true}))
 await fs.copyFile(path.join(OUT,'02-storyboard.png'),path.join(MEDIA,'storyboard.png'))
 await page.locator('#audio-file').setInputFiles({name:'完整配音-合成演示.wav',mimeType:'audio/wav',buffer:demoWav()})
 await page.waitForFunction(()=>!document.getElementById('recording-player').hidden&&document.getElementById('recording-player').readyState>=1&&document.getElementById('retry-recording').hidden)
 await view('#record');await capture('03-recording','3 / 5  上传或录制一整段配音',page.locator('label').filter({has:page.locator('#audio-file')}))
 await fs.copyFile(path.join(OUT,'03-recording.png'),path.join(MEDIA,'recording.png'))
 // Explicit human/test markers in the actual UI; these are not ASR of oscillator tones.
 await page.locator('#manual-markers summary').click()
 const rows=page.locator('#markers .marker-row')
 await rows.nth(0).getByLabel('开始（秒）',{exact:true}).fill('0.2');await rows.nth(0).getByLabel('结束（秒）',{exact:true}).fill('0.8')
 await rows.nth(1).getByLabel('开始（秒）',{exact:true}).fill('2.6');await rows.nth(1).getByLabel('结束（秒）',{exact:true}).fill('3.3')
 await view('#manual-markers');await capture('04-timing','4 / 5  演示：在整段录音上标记台词',page.locator('#submit-markers'))
 await page.locator('#submit-markers').click()
 await page.waitForFunction(()=>!document.getElementById('preview').disabled,{},{timeout:30000})
 await page.locator('#manual-markers summary').click()
 await view('#make');await page.locator('#preview').click()
 await page.locator('#jobs .job-card').filter({hasText:'制作电影'}).first().waitFor()
 await page.waitForFunction(()=>{const v=document.getElementById('movie-player');return !v.hidden&&v.readyState>=2},{},{timeout:60000})
 await view('#watch')
 await page.locator('#movie-player').evaluate(async video=>{video.muted=true;video.currentTime=6.5;await video.play()})
 await page.waitForFunction(()=>document.getElementById('movie-player').currentTime>6.65)
 await page.locator('#movie-player').evaluate(video=>video.pause())
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
 await capture('05-movie','5 / 5  看成片，再告诉助手想改哪里',page.locator('#movie-player'))
 await fs.copyFile(path.join(OUT,'05-movie.png'),path.join(MEDIA,'movie.png'))
 // A real Core review proposal, but no model session/reply is fabricated.
 const projects=await api('/projects'),project=await api('/projects/'+projects[0].id)
 const lines=project.scenes.flatMap(s=>s.dialogue)
 await core.dispatch('timeline.propose',{projectId:project.id,expectedRevision:project.revision,operation:{type:'shorten_pause',afterDialogueId:lines[0].id,beforeDialogueId:lines[1].id,targetSeconds:.6}})
 await page.locator('[data-proposal-id]').waitFor({timeout:15000})
 await view('#review-cards');await page.evaluate(()=>scrollBy(0,-20));await capture('06-review','修改之前：试听原段，由作者确认',page.getByRole('button',{name:'试听原段',exact:true}))
 await fs.copyFile(path.join(OUT,'06-review.png'),path.join(MEDIA,'review.png'))
 await page.screenshot({path:path.join(OUT,'full-page-diagnostic.png'),fullPage:true,animations:'disabled'})
 if(errors.length)throw new Error(errors.join('\n'))
 const report={viewport:{width:1000,height:700},deviceScaleFactor:1,captures,privacy:'Isolated local project; no production cookies/storage, no microphone, auth flow, real ASR or model call.',media:'Generated CC0 geometry/oscillator tones with explicitly entered manual markers. Real HTTP, Core and MP4 rendering.',browserErrors:errors}
 await fs.writeFile(path.join(OUT,'capture.json'),JSON.stringify(report,null,2))
 console.log(JSON.stringify({captured:captures.length,viewport:report.viewport,media:report.media},null,2))
}finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}await core.close();await fs.rm(temporary,{recursive:true,force:true})}
