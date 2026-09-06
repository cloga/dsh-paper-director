import { promises as fs } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { ProjectStore } from './store.js'
import { MediaWorker, resolveWorkerOutput, readBoundedOutput } from './worker.js'
import { publicError, publicWarnings } from './diagnostics.js'
import { ProjectError, fail, id, object, text, clone } from './model.js'
import { validateAlignment, compileTimeline, proposePauseEdit, applyPauseEdit } from './timeline.js'
import { synthesizeNarration, narrationReady } from './tts.js'
import { addBuiltInEffects } from './sounds.js'

const TERMINAL=new Set(['succeeded','failed','cancelled','interrupted'])
const STAGES=new Set(['queued','starting','probe','align','render','frame','encode','mix','complete','working'])
const jobDto=j=>({id:j.id,projectId:j.projectId,kind:j.kind,revision:j.revision,status:j.status,progress:j.progress,stage:j.stage,createdAt:j.createdAt,updatedAt:j.updatedAt,result:j.result,error:j.error})
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
function expected(value){if(!Number.isSafeInteger(value)||value<1)fail('EXPECTED_REVISION_REQUIRED','请先刷新作品版本。',409);return value}
const cancelled=signal=>{if(signal?.aborted)fail('CANCELLED','任务已取消。')}

/** Deterministic application service; no DSH imports, secrets or filesystem paths in public DTOs. */
export class PaperDirectorCore {
  constructor(config={},dependencies={}) {
    this.config={maxAssetBytes:100*1024*1024,maxProjectBytes:512*1024*1024,maxJobsPerProject:200,workerTimeoutMs:300000,...config,dataDir:config.dataDir||path.join(process.env.DSH_HOME||path.join(homedir(),'.dsh'),'paper-director'),pythonPath:config.pythonPath||'python',fontPath:config.fontPath||'',asrModelPath:config.asrModelPath||'',asrEngine:config.asrEngine||'whisper',allowCloudTts:config.allowCloudTts===true,azureRegion:config.azureRegion||'',azureKeyEnv:config.azureKeyEnv||'AZURE_SPEECH_KEY'}
    this.store=dependencies.store||new ProjectStore(this.config)
    this.worker=dependencies.worker||new MediaWorker(this.config)
    this.tts=dependencies.tts||synthesizeNarration
    this.queue=[];this.active=new Map();this.controllers=new Map();this.closed=false;this.initialized=false;this.closePromise=null
    this.agentStarter=undefined;this.agentStarting=new Set();this.healthCache=null;this.reserved=0
    this.importTasks=new Set();this.enqueueTasks=new Set();this.volatileFailures=new Map()
  }
  async init(){
    if(this.initialized)return this
    await this.store.init()
    this.store.db.exec('CREATE TABLE IF NOT EXISTS agent_bindings(session_id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id)); CREATE TABLE IF NOT EXISTS tts_ledger(id TEXT PRIMARY KEY,day TEXT NOT NULL,characters INTEGER NOT NULL);')
    const jobsDir=path.join(this.store.root,'jobs');await fs.mkdir(jobsDir,{recursive:true,mode:0o700})
    // The store lease excludes any other live owner. These are derivative/temp files only.
    for(const entry of await fs.readdir(jobsDir,{withFileTypes:true}))if(/^(?:health-|import-)?[a-f0-9-]{36}$/.test(entry.name))await fs.rm(path.join(jobsDir,entry.name),{recursive:true,force:true}).catch(()=>{})
    this.initialized=true;return this
  }
  checkOpen(){if(!this.initialized||this.closed)fail('SERVICE_UNAVAILABLE','工作室暂时不可用。',503)}
  setAgentStarter(fn){if(fn!==undefined&&typeof fn!=='function')throw new TypeError('Agent starter must be a function');this.agentStarter=fn}
  async agentReady(){try{return !!this.agentStarter&&(typeof this.agentStarter.ready!=='function'||await this.agentStarter.ready())}catch{return false}}
  async bindSession(sessionId,projectId){this.checkOpen();id(sessionId,'session id');await this.store.get(projectId);const existing=this.store.db.prepare('SELECT project_id FROM agent_bindings WHERE session_id=?').get(sessionId);if(existing&&existing.project_id!==projectId)fail('BINDING_EXISTS','会话已经绑定另一部作品。',409);this.store.db.prepare('INSERT OR IGNORE INTO agent_bindings(session_id,project_id) VALUES(?,?)').run(sessionId,projectId)}
  async bindingForSession(sessionId){this.checkOpen();id(sessionId,'session id');return this.store.db.prepare('SELECT project_id FROM agent_bindings WHERE session_id=?').get(sessionId)?.project_id}
  validateScope(scope){if(scope===undefined)return;object(scope,'scope');if(Object.keys(scope).length!==1||typeof scope.projectId!=='string')fail('PROJECT_FORBIDDEN','缺少可信作品绑定。',403);id(scope.projectId)}
  projectId(args,scope){if(scope){if(args.projectId!==undefined&&args.projectId!==scope.projectId)fail('PROJECT_FORBIDDEN','只能操作当前绑定的作品。',403);return scope.projectId}return id(args.projectId,'project id')}
  async asset(projectId,assetId){this.checkOpen();return this.store.asset(projectId,assetId)}
  publicJob(job){return jobDto(this.volatileFailures.has(job.id)?{...job,status:'failed',stage:'failed',error:this.volatileFailures.get(job.id)}:job)}
  async health(){
    this.checkOpen()
    if(this.healthCache&&Date.now()-this.healthCache.at<15000)return clone({...this.healthCache.value,agent:{configured:await this.agentReady()},narration:{configured:narrationReady(this.config)}})
    if(this.healthPending)return this.healthPending
    this.healthPending=(async()=>{
      let raw=null;const outputDir=path.join(this.store.root,'jobs','health-'+randomUUID())
      try{raw=await this.worker.run({action:'health',outputDir,...(this.config.fontPath?{fontPath:this.config.fontPath}:{}),...(this.config.asrModelPath?{modelPath:this.config.asrModelPath}:{})})}catch{}finally{await fs.rm(outputDir,{recursive:true,force:true}).catch(()=>{})}
      const missing=[]
      if(!raw)missing.push('媒体组件未就绪，请由家长配置Python环境。')
      else{for(const name of ['av','numpy','Pillow'])if(!raw.dependencies?.[name])missing.push(name);if(!raw.cjkReady)missing.push('中文字体');for(const name of ['libx264','aac'])if(!raw.codecs?.[name])missing.push(name)}
      const asrDependency=this.config.asrEngine==='vosk'?'vosk':'faster-whisper'
      const value={version:'0.1.0',render:{ready:!!(raw?.ready&&raw?.cjkReady)},alignment:{configured:!!(raw?.modelReady&&raw?.models?.[this.config.asrEngine]&&raw?.dependencies?.[asrDependency]),engine:this.config.asrEngine},agent:{configured:await this.agentReady()},narration:{configured:narrationReady(this.config)},worker:{available:!!raw,missing}}
      this.healthCache={at:Date.now(),value};return clone(value)
    })().finally(()=>{this.healthPending=null})
    return this.healthPending
  }
  importAsset(projectId,revision,input){
    this.checkOpen();if(this.importTasks.size>=2)fail('UPLOAD_BUSY','正在导入素材，请稍后再试。',429)
    const task=this.performImport(projectId,revision,input);this.importTasks.add(task);task.then(()=>this.importTasks.delete(task),()=>this.importTasks.delete(task));return task
  }
  async performImport(projectId,expectedRevision,{name,kind,buffer}){
    const project=await this.store.get(projectId);if(project.revision!==expected(expectedRevision))fail('REVISION_CONFLICT','作品已更新，请刷新后重新导入。',409)
    if(!['image','audio'].includes(kind)||!Buffer.isBuffer(buffer))fail('INVALID_UPLOAD','请选择图片或完整录音。')
    if(buffer.length===0||buffer.length>this.config.maxAssetBytes)fail('ASSET_TOO_LARGE','文件为空或超过大小限制。',413)
    this.store.checkAssetQuota(projectId,buffer.length)
    const directory=path.join(this.store.root,'jobs','import-'+randomUUID()),inputPath=path.join(directory,'upload.bin'),outputDir=path.join(directory,'probe')
    await fs.mkdir(directory,{recursive:true,mode:0o700})
    try{
      this.checkOpen();await fs.writeFile(inputPath,buffer,{flag:'wx',mode:0o600})
      const meta=await this.worker.run({action:'probe',inputPath,outputDir})
      if(meta.kind!==kind)fail('MEDIA_TYPE_MISMATCH',kind==='audio'?'请选择仅包含录音的音频文件。':'请选择单张静态图片。',415)
      this.checkOpen();return await this.store.addAsset(projectId,expectedRevision,{name,kind,mime:meta.mime,buffer,metadata:meta})
    }finally{await fs.rm(directory,{recursive:true,force:true}).catch(()=>{})}
  }
  async startAgent({projectId,expectedRevision,prompt}){
    this.checkOpen();const p=await this.store.get(projectId)
    if(p.revision!==expected(expectedRevision))fail('REVISION_CONFLICT','作品已更新，请先保存并刷新。',409)
    if(!await this.agentReady())fail('AGENT_NOT_READY','导演助手尚未配置，请让家长安装专用配置。',503)
    const message=text(prompt,16000,'production prompt');if(!message)fail('EMPTY_PROMPT','请告诉助手你想制作或修改什么。')
    if(this.agentStarting.has(projectId))fail('AGENT_STARTING','这个作品正在启动助手，请稍候。',409)
    this.agentStarting.add(projectId)
    try{this.checkOpen();return await this.agentStarter({projectId,prompt:message})}catch{throw new ProjectError('AGENT_START_FAILED','助手未能启动，请检查专用配置与模型设置。',503)}finally{this.agentStarting.delete(projectId)}
  }
  async dispatch(operation,args={},scope){
    this.checkOpen();object(args,'arguments');this.validateScope(scope)
    if(operation==='project.list'){if(scope)fail('PROJECT_FORBIDDEN','绑定会话不能查看其他作品。',403);return this.store.list()}
    if(operation==='project.create'){if(scope)fail('PROJECT_FORBIDDEN','请从工作室新建作品。',403);return this.store.create(args.input??args)}
    if(operation==='job.get'||operation==='job.cancel'){
      const j=await this.store.jobGet(args.jobId)
      if(scope&&j.projectId!==scope.projectId||args.projectId!==undefined&&j.projectId!==args.projectId)fail('JOB_FORBIDDEN','只能查看当前作品的制作任务。',403)
      return operation==='job.cancel'?this.cancel(j):this.publicJob(j)
    }
    const projectId=this.projectId(args,scope)
    if(operation==='project.get')return this.store.get(projectId,args.revision)
    if(operation==='project.history')return this.store.history(projectId)
    if(operation==='project.restore')return this.store.restore(projectId,expected(args.expectedRevision),args.revision)
    if(operation==='project.update')return this.store.update(projectId,expected(args.expectedRevision),args.patch)
    if(operation==='job.list')return (await this.store.jobs(projectId)).map(j=>this.publicJob(j))
    const project=await this.store.get(projectId)
    if(project.revision!==expected(args.expectedRevision))fail('REVISION_CONFLICT','作品已更新，请刷新。',409)
    if(operation==='timeline.propose'||operation==='timeline.apply'){
      const op=object(args.operation,'edit operation');if(op.type!=='shorten_pause')fail('INVALID_EDIT','不支持这种修改。')
      const proposal=proposePauseEdit(project,{afterDialogueId:op.afterDialogueId,beforeDialogueId:op.beforeDialogueId,targetSeconds:op.targetSeconds})
      if(operation==='timeline.propose')return proposal
      if(!proposal.cuts.length)return project
      return this.store.mutate(projectId,args.expectedRevision,p=>applyPauseEdit(p,proposal,{allowUnmatchedSpeech:scope?false:args.allowUnmatchedSpeech===true}))
    }
    if(operation==='recording.align'){
      if(!project.recordingAssetId||!project.scenes.length)fail('NOT_READY','先准备照片、台词和一整段录音。')
      const engine=args.engine||this.config.asrEngine
      if(!['whisper','vosk','segments'].includes(engine))fail('INVALID_ENGINE','请选择受支持的本地对齐方式。')
      if(scope&&engine==='segments')fail('MANUAL_ALIGNMENT_ONLY','人工标记只能从工作室确认。',403)
      if(engine==='segments'&&(!Array.isArray(args.segments)||args.segments.length>5000))fail('INVALID_ALIGNMENT','请提供明确的人工时间标记。')
      if(engine!=='segments'&&!this.config.asrModelPath)fail('MODEL_NOT_READY','本地语音模型未配置，可先使用人工时间标记。',503)
      return this.enqueue(project,'align',{engine,...(engine==='segments'?{segments:args.segments}:{})})
    }
    if(operation==='movie.render'){const timeline=compileTimeline(project);if(timeline.duration>900)fail('PROJECT_TOO_LONG','第一版暂支持15分钟以内成片。');return this.enqueue(project,'render',{preview:args.preview===true})}
    if(operation==='narration.generate'){
      if(!narrationReady(this.config))fail('TTS_DISABLED','旁白需要家长配置并开启Azure语音服务。',503)
      const narration=text(args.text,500,'narration');if(!narration)fail('EMPTY_TEXT','旁白文字不能为空。')
      if(args.voiceProfile!==undefined&&args.voiceProfile!=='narrator')fail('INVALID_VOICE','只使用已配置的旁白声线。')
      const fingerprint=digest({text:narration,voice:'zh-CN-XiaoxiaoNeural',region:this.config.azureRegion})
      const past=await this.store.jobs(projectId)
      const prior=past.find(j=>j.kind==='narration'&&j.input?.ttsFingerprint===fingerprint&&['queued','running','succeeded','interrupted'].includes(j.status))
      if(prior){
        if(prior.status==='succeeded'&&prior.result?.assetId&&!project.assets.some(a=>a.id===prior.result.assetId)){
          const {path:_internal,...asset}=await this.store.asset(projectId,prior.result.assetId)
          const restored=await this.store.mutate(projectId,args.expectedRevision,p=>{p.assets.push(asset);return p})
          return {...this.publicJob(prior),relinkedRevision:restored.revision}
        }
        return this.publicJob(prior)
      }
      if(past.some(j=>j.kind==='narration'&&j.input?.ttsFingerprint===fingerprint&&j.error?.code==='TTS_UNCERTAIN'))fail('TTS_UNCERTAIN','上次请求结果不确定，为避免重复费用请让家长检查Azure用量。',409)
      return this.enqueue(project,'narration',{text:narration,ttsFingerprint:fingerprint})
    }
    fail('UNKNOWN_OPERATION','不支持的制作操作。',404)
  }
  enqueue(project,kind,input){
    this.checkOpen();if(this.queue.length+this.active.size+this.reserved>=30)fail('QUEUE_FULL','制作队列已满，请稍后再试。',429)
    this.reserved++
    const task=(async()=>{
      const fingerprint=digest({kind,revision:project.revision,input})
      this.checkOpen();const job=await this.store.jobCreate(project.id,kind,project.revision,{...clone(input),fingerprint})
      if(job.reused)return this.publicJob(job)
      if(this.closed)return this.publicJob(await this.store.jobUpdate(job.id,{status:'cancelled',stage:'cancelled',error:{code:'SERVICE_CLOSED',message:'工作室已停止。'}}))
      this.controllers.set(job.id,new AbortController());this.queue.push(job.id);this.pump();return this.publicJob(job)
    })().finally(()=>{this.reserved--})
    this.enqueueTasks.add(task);task.then(()=>this.enqueueTasks.delete(task),()=>this.enqueueTasks.delete(task));return task
  }
  pump(){
    if(this.closed||this.active.size||!this.queue.length)return
    const jobId=this.queue.shift()
    const task=this.executeJob(jobId).catch(error=>{this.volatileFailures.set(jobId,publicError(error))}).finally(()=>{this.active.delete(jobId);this.controllers.delete(jobId);this.pump()})
    this.active.set(jobId,task)
  }
  async executeJob(jobId){
    id(jobId);const signal=this.controllers.get(jobId)?.signal
    const directory=path.join(this.store.root,'jobs',jobId),outputDir=path.join(directory,'output')
    let job=null,result=null,committed=false,remoteAttempted=false,progressChain=Promise.resolve(),lastProgress=0
    const progress=event=>{if(!Number.isFinite(event.progress)||event.progress-lastProgress<.03&&event.progress<1)return;lastProgress=event.progress;progressChain=progressChain.then(async()=>{if(!signal?.aborted&&!committed)await this.store.jobUpdate(jobId,{progress:Math.max(0,Math.min(1,event.progress)),stage:STAGES.has(event.stage)?event.stage:'working'})}).catch(()=>{})}
    try{
      job=await this.store.jobGet(jobId);cancelled(signal)
      await this.store.jobUpdate(jobId,{status:'running',stage:'starting',progress:0})
      const project=await this.store.get(job.projectId,job.revision)
      if(job.kind==='align'){
        const audio=await this.store.asset(project.id,project.recordingAssetId)
        const request={action:'align',outputDir,inputPath:audio.path,characters:project.characters,scenes:project.scenes.map(s=>({...s,dialogue:s.dialogue.filter(d=>d.text.trim())})),engine:job.input.engine,...(job.input.engine==='segments'?{segments:job.input.segments}:{modelPath:this.config.asrModelPath})}
        const aligned=validateAlignment(project,await this.worker.run(request,{signal,onProgress:progress}))
        if(Math.abs((audio.metadata.timestampDuration??audio.metadata.duration)-audio.metadata.duration)>.05)aligned.warnings.push({code:'RECORDING_CLOCK'})
        aligned.warnings=publicWarnings(aligned.warnings)
        await progressChain;cancelled(signal)
        try{await this.store.mutate(project.id,job.revision,p=>{p.alignment=aligned;p.edits=[];result={applied:true,inputRevision:job.revision,revision:p.revision+1,alignment:aligned};this.store.finishJobInMutation(jobId,result);return p});committed=true}
        catch(e){if(e.code!=='REVISION_CONFLICT')throw e;result={applied:false,inputRevision:job.revision,revision:null,alignment:aligned}}
      }else if(job.kind==='render'){
        const timeline=compileTimeline(project),assets={}
        if(job.input.preview){const scale=Math.min(1,640/timeline.width,480/timeline.height);timeline.width=Math.max(160,Math.round(timeline.width*scale/2)*2);timeline.height=Math.max(120,Math.round(timeline.height*scale/2)*2)}
        const ids=new Set([project.recordingAssetId,...timeline.cues.flatMap(c=>[c.imageAssetId,c.fromAssetId]).filter(Boolean),...timeline.audioOverlays.map(a=>a.assetId)])
        for(const assetId of ids){const a=await this.store.asset(project.id,assetId);assets[a.id]={path:a.path,kind:a.kind,mime:a.mime,metadata:a.metadata}}
        await addBuiltInEffects(project,timeline,assets,path.join(directory,'sounds'));cancelled(signal)
        const rendered=await this.worker.run({action:'render',outputDir,timeline,assets,recordingAssetId:project.recordingAssetId,preview:job.input.preview,...(this.config.fontPath?{fontPath:this.config.fontPath}:{})},{signal,onProgress:progress})
        await progressChain;cancelled(signal)
        const file=await resolveWorkerOutput(outputDir,rendered.path),buffer=await readBoundedOutput(file,this.config.maxAssetBytes)
        const current=await this.store.get(project.id),stale=current.revision!==job.revision
        const warnings=publicWarnings([...timeline.warnings,...(Array.isArray(rendered.warnings)?rendered.warnings:[])])
        await this.store.addAsset(project.id,current.revision,{name:job.input.preview?'预览电影.mp4':'我的电影.mp4',kind:'video',mime:'video/mp4',buffer,metadata:{duration:timeline.duration,width:timeline.width,height:timeline.height,codec:'h264',audioStreams:1,videoStreams:1,sampleRate:48000,channels:2}},{signal,onProject:(p,asset)=>{
          const entry={jobId,assetId:asset.id,inputRevision:job.revision,preview:job.input.preview,createdAt:new Date().toISOString(),warnings}
          if(!stale)p.exports.push(entry)
          result={...entry,applied:!stale,revision:p.revision+1};this.store.finishJobInMutation(jobId,result);return p
        }});committed=true
      }else if(job.kind==='narration'){
        cancelled(signal);const day=new Date().toISOString().slice(0,10)
        this.store.db.exec('BEGIN IMMEDIATE')
        try{const used=this.store.db.prepare('SELECT COALESCE(SUM(characters),0) AS n FROM tts_ledger WHERE day=?').get(day).n;if(used+job.input.text.length>5000)fail('TTS_BUDGET','今日旁白额度达到上限，请让家长检查。',429);this.store.db.prepare('INSERT INTO tts_ledger(id,day,characters) VALUES(?,?,?)').run(job.id,day,job.input.text.length);this.store.db.exec('COMMIT')}catch(e){this.store.db.exec('ROLLBACK');throw e}
        await this.store.jobUpdate(jobId,{stage:'tts-requesting',result:{remoteAttempted:true}})
        cancelled(signal);remoteAttempted=true
        const generated=await this.tts(this.config,job.input.text,{signal});cancelled(signal)
        const current=await this.store.get(project.id)
        await this.store.addAsset(project.id,current.revision,{name:'Azure旁白.wav',kind:'audio',mime:'audio/wav',buffer:generated.buffer,metadata:generated.metadata},{signal,onProject:(p,asset)=>{
          result={assetId:asset.id,inputRevision:job.revision,revision:p.revision+1,applied:current.revision===job.revision,text:job.input.text,voice:generated.voice,duration:generated.metadata.duration};this.store.finishJobInMutation(jobId,result);return p
        }});committed=true
      }else fail('UNKNOWN_JOB','未知制作任务。')
      if(!committed){await progressChain;cancelled(signal);await this.store.jobUpdate(jobId,{status:'succeeded',progress:1,stage:'complete',result,error:null})}
    }catch(error){
      await progressChain
      if(!committed){
        if(remoteAttempted&&!['TTS_AUTH','TTS_RATE_LIMIT','TTS_DISABLED','EMPTY_TEXT'].includes(error?.code))error=new ProjectError('TTS_UNCERTAIN','旁白请求可能已完成，但未能安全保存；为避免重复费用请让家长检查。')
        const uncertain=error?.code==='TTS_UNCERTAIN',failure=publicError(error)
        try{await this.store.jobUpdate(jobId,{status:signal?.aborted&&!uncertain?'cancelled':'failed',stage:uncertain?'uncertain':signal?.aborted?'cancelled':'failed',error:failure})}catch{this.volatileFailures.set(jobId,failure)}
      }
    }finally{await fs.rm(directory,{recursive:true,force:true}).catch(()=>{})}
  }
  async cancel(stale){
    const job=this.store.jobRead(stale.id)
    if(TERMINAL.has(job.status))return this.publicJob(job)
    this.controllers.get(job.id)?.abort();this.queue=this.queue.filter(id=>id!==job.id)
    if(!this.active.has(job.id)){this.controllers.delete(job.id);return this.publicJob(await this.store.jobUpdate(job.id,{status:'cancelled',stage:'cancelled',error:{code:'CANCELLED',message:'任务已取消。'}}))}
    return this.publicJob(job)
  }
  async close(){
    if(this.closePromise)return this.closePromise
    this.closed=true;this.agentStarter=undefined
    this.closePromise=(async()=>{
      for(const controller of this.controllers.values())controller.abort()
      await Promise.allSettled([...this.enqueueTasks])
      if(this.initialized)for(const jobId of this.queue)await this.store.jobUpdate(jobId,{status:'cancelled',stage:'cancelled',error:{code:'SERVICE_CLOSED',message:'工作室已停止。'}}).catch(()=>{})
      this.queue=[]
      await this.worker.close();await Promise.allSettled([...this.active.values(),...this.importTasks]);await this.healthPending?.catch(()=>{})
      this.store.close();this.initialized=false
    })();return this.closePromise
  }
}
