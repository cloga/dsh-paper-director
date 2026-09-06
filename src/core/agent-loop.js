import { clone, fail, id, object, finite } from './model.js'
import { proposePauseEdit, applyPauseEdit } from './timeline.js'

const TERMINAL=new Set(['succeeded','failed','cancelled','interrupted'])
const TURN_REASONS=new Set(['completed','aborted','blocked','error','max-tokens','interrupted'])
/** Application-owned coordination. Never holds or serializes a live DSH Session. */
export class StudioAgentLoop {
  constructor(core){this.core=core;this.notifier=undefined;this.reader=undefined;this.closed=false;this.draining=null;this.statusPending=new Map()}
  get db(){return this.core.store.db}
  init(){this.db.exec(`
    CREATE TABLE IF NOT EXISTS paper_job_subscribers(job_id TEXT NOT NULL,session_id TEXT NOT NULL,project_id TEXT NOT NULL,PRIMARY KEY(job_id,session_id));
    CREATE TABLE IF NOT EXISTS paper_agent_notices(id TEXT NOT NULL,session_id TEXT NOT NULL,project_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,delivery TEXT NOT NULL DEFAULT 'pending',PRIMARY KEY(id,session_id,kind));
    CREATE TABLE IF NOT EXISTS paper_proposals(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,base_revision INTEGER NOT NULL,session_id TEXT,status TEXT NOT NULL,document TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS paper_proposal_project ON paper_proposals(project_id,base_revision,status);
  `)}
  bound(sessionId,projectId){if(typeof sessionId!=='string'||typeof projectId!=='string')return false;return this.db.prepare('SELECT project_id FROM agent_bindings WHERE session_id=?').get(sessionId)?.project_id===projectId}
  onNotice(callback){if(typeof callback!=='function')throw new TypeError('Notice callback required');if(this.notifier)throw new Error('A notice owner is already registered');this.notifier=callback;void this.drain();return ()=>{if(this.notifier===callback)this.notifier=undefined}}
  setReader(fn){if(fn!==undefined&&typeof fn!=='function')throw new TypeError('Status reader must be callable');this.reader=fn}
  subscribe(job,sessionId){
    const current=this.core.store.jobRead(job.id)
    if(!sessionId||TERMINAL.has(current.status))return current
    if(!this.bound(sessionId,current.projectId))fail('PROJECT_FORBIDDEN','制作任务与会话绑定不一致。',403)
    this.db.prepare('INSERT OR IGNORE INTO paper_job_subscribers(job_id,session_id,project_id) VALUES(?,?,?)').run(current.id,sessionId,current.projectId)
    return current
  }
  settled(job){
    if(this.closed||this.core.closed||!TERMINAL.has(job.status)||!['align','narration','render'].includes(job.kind))return
    if(job.status==='succeeded'&&(job.kind==='render'||job.result?.applied===false))return // No render loop or work on a superseded revision.
    for(const sub of this.db.prepare('SELECT session_id,project_id FROM paper_job_subscribers WHERE job_id=?').all(job.id))this.queueNotice({id:job.id,sessionId:sub.session_id,projectId:sub.project_id,kind:job.kind,status:job.status})
    void this.drain()
  }
  queueNotice({id:noticeId,projectId,sessionId,kind,status}){
    if(!sessionId||!this.bound(sessionId,projectId))return
    this.db.prepare('INSERT OR IGNORE INTO paper_agent_notices(id,session_id,project_id,kind,status) VALUES(?,?,?,?,?)').run(noticeId,sessionId,projectId,kind,status)
  }
  async drain(){
    if(this.draining||!this.notifier||this.closed||this.core.closed)return this.draining
    let failed=false
    this.draining=(async()=>{
      while(this.notifier&&!this.closed&&!this.core.closed){
        const row=this.db.prepare("SELECT * FROM paper_agent_notices WHERE delivery='pending' ORDER BY rowid LIMIT 1").get();if(!row)break
        // Claim before sending; a crash cannot blindly repeat a model wakeup.
        const claim=this.db.prepare("UPDATE paper_agent_notices SET delivery='claimed' WHERE id=? AND session_id=? AND kind=? AND delivery='pending'").run(row.id,row.session_id,row.kind)
        if(!claim.changes)continue
        let delivery='rejected'
        try{
          if(this.bound(row.session_id,row.project_id)){
            const callback=this.notifier
            const result=await callback({id:row.id,projectId:row.project_id,sessionId:row.session_id,kind:row.kind,status:row.status})
            delivery=['queued','cold','rejected','stopped'].includes(result?.delivery)?result.delivery:'rejected'
          }
        }catch{delivery='rejected'}
        if(this.closed||this.core.closed)break
        this.db.prepare('UPDATE paper_agent_notices SET delivery=? WHERE id=? AND session_id=? AND kind=?').run(delivery,row.id,row.session_id,row.kind)
      }
    })().catch(()=>{failed=true}).finally(()=>{
      this.draining=null
      if(!failed&&this.notifier&&!this.closed&&!this.core.closed){
        try{if(this.db.prepare("SELECT 1 FROM paper_agent_notices WHERE delivery='pending' LIMIT 1").get())return this.drain()}catch{/* No hot-loop retries on a storage failure. */}
      }
    })
    return this.draining
  }
  saveProposal(project,proposal,sessionId){
    if(!proposal.cuts.length)return proposal
    if(sessionId&&!this.bound(sessionId,project.id))fail('PROJECT_FORBIDDEN','剪辑建议的会话未绑定此作品。',403)
    const after=project.alignment.utterances.find(u=>u.dialogueId===proposal.request.afterDialogueId)
    const before=project.alignment.utterances.find(u=>u.dialogueId===proposal.request.beforeDialogueId)
    const value={...proposal,sourceRange:{start:Math.max(0,after.end-.25),end:Math.min(project.alignment.duration,before.start+.4)}}
    const existing=this.db.prepare('SELECT id,status,session_id FROM paper_proposals WHERE id=?').get(proposal.id)
    if(existing?.status==='dismissed')fail('REVIEW_DISMISSED','作者已选择保留原样，不再重复这条剪辑建议。',409)
    if(existing?.status==='pending'&&!existing.session_id&&sessionId)this.db.prepare('UPDATE paper_proposals SET session_id=? WHERE id=? AND session_id IS NULL').run(sessionId,proposal.id)
    if(!existing&&this.db.prepare("SELECT COUNT(*) AS n FROM paper_proposals WHERE project_id=? AND base_revision=? AND status='pending'").get(project.id,project.revision).n>=30)fail('REVIEW_LIMIT','待确认建议太多，请先处理已有建议。',429)
    this.db.prepare("INSERT OR IGNORE INTO paper_proposals(id,project_id,base_revision,session_id,status,document,created_at) VALUES(?,?,?,?,'pending',?,?)").run(proposal.id,project.id,project.revision,sessionId||null,JSON.stringify(value),new Date().toISOString())
    return value
  }
  proposals(project){return this.db.prepare("SELECT document FROM paper_proposals WHERE project_id=? AND base_revision=? AND status='pending' ORDER BY rowid LIMIT 30").all(project.id,project.revision).map(r=>JSON.parse(r.document))}
  async status(projectId){
    const row=this.db.prepare('SELECT session_id FROM agent_bindings WHERE project_id=? ORDER BY rowid DESC LIMIT 1').get(projectId)
    const empty={sessionId:row?.session_id||null,liveStatus:'cold',lastTurnReason:null,messages:[]}
    if(!row||!this.reader||this.closed)return empty
    if(this.statusPending.has(projectId))return this.statusPending.get(projectId)
    const task=(async()=>{
      try{
        const reader=this.reader,raw=await reader(row.session_id)
        if(this.closed||this.core.closed||this.reader!==reader||!this.bound(row.session_id,projectId))return empty
        const result={...empty,liveStatus:['idle','running','cold'].includes(raw?.liveStatus)?raw.liveStatus:'cold',lastTurnReason:TURN_REASONS.has(raw?.lastTurnReason)?raw.lastTurnReason:null}
        let remaining=8000
        for(const message of (Array.isArray(raw?.messages)?raw.messages:[]).slice(-10)){
          if(typeof message.text!=='string'||!Number.isSafeInteger(message.seq)||message.seq<0||remaining<=0)continue
          const value=message.text.slice(0,remaining);remaining-=value.length
          result.messages.push({id:typeof message.id==='string'?message.id.slice(0,128):String(message.seq),seq:message.seq,text:value,interrupted:message.interrupted===true})
        }
        return result
      }catch{return {...empty,unavailable:true}}
    })().finally(()=>this.statusPending.delete(projectId))
    this.statusPending.set(projectId,task);return task
  }
  async review(projectId){
    await this.core.store.get(projectId);this.core.checkOpen()
    const agent=await this.status(projectId);this.core.checkOpen()
    const project=await this.core.store.get(projectId);this.core.checkOpen()
    return {projectId,revision:project.revision,agent,proposals:this.proposals(project)}
  }
  async decide(projectId,proposalId,input){
    id(projectId);id(proposalId);object(input,'review decision')
    if(Object.keys(input).some(k=>!['expectedRevision','decision'].includes(k))||!['apply','dismiss'].includes(input.decision)||!Number.isSafeInteger(input.expectedRevision))fail('INVALID_REVIEW','请使用有效的确认操作。')
    const row=this.db.prepare('SELECT * FROM paper_proposals WHERE id=? AND project_id=?').get(proposalId,projectId)
    if(!row)fail('REVIEW_NOT_FOUND','找不到这条剪辑建议。',404)
    if(row.status!=='pending'||row.base_revision!==input.expectedRevision)fail('REVISION_CONFLICT','建议已经处理或过期，请刷新。',409)
    const saved=JSON.parse(row.document)
    let result
    if(input.decision==='apply'){
      result=await this.core.store.mutate(projectId,input.expectedRevision,project=>{
        const fresh=proposePauseEdit(project,saved.request)
        if(fresh.id!==saved.id)fail('REVISION_CONFLICT','作品已变化，请重新预览这条建议。',409)
        const edited=applyPauseEdit(project,fresh,{allowUnmatchedSpeech:true})
        this.db.prepare("UPDATE paper_proposals SET status='applied' WHERE id=?").run(proposalId)
        this.queueNotice({id:proposalId,projectId,sessionId:row.session_id,kind:'review',status:'approved'})
        return edited
      })
    }else{
      // No content revision for dismiss, but its revision check and decision are atomic.
      this.db.exec('BEGIN IMMEDIATE')
      try{
        if(this.db.prepare('SELECT revision FROM projects WHERE id=?').get(projectId)?.revision!==input.expectedRevision)fail('REVISION_CONFLICT','作品已变化，请刷新。',409)
        this.db.prepare("UPDATE paper_proposals SET status='dismissed' WHERE id=? AND status='pending'").run(proposalId)
        this.queueNotice({id:proposalId,projectId,sessionId:row.session_id,kind:'review',status:'dismissed'})
        this.db.exec('COMMIT')
      }catch(error){this.db.exec('ROLLBACK');throw error}
      result=await this.core.store.get(projectId)
    }
    void this.drain();return result
  }
  async locate(projectId,{assetId,time}){
    id(assetId);const project=await this.core.store.get(projectId)
    await this.core.store.asset(projectId,assetId)
    const job=(await this.core.store.jobs(projectId)).find(j=>j.kind==='render'&&j.status==='succeeded'&&j.result?.assetId===assetId)
    const index=job?.result?.timelineIndex
    if(!index)fail('TIMELINE_INDEX_UNAVAILABLE','这个旧版电影没有时间索引，请重新制作后定位。',409)
    finite(time,0,index.duration+.05,'movie time') // A container may round up by one picture frame.
    const sampled=Math.min(time,Math.max(0,index.duration-1e-9))
    const source=await this.core.store.get(projectId,job.revision)
    const cue=index.cues.find(c=>c.start<=sampled&&sampled<c.end)
    const kind=sampled<index.introSeconds?'intro':index.outroSeconds>0&&sampled>=index.duration-index.outroSeconds?'outro':cue?.kind||'scene'
    const original=source.scenes.find(s=>s.id===cue?.sceneId)
    const active=index.subtitles.filter(s=>s.start<=sampled&&sampled<s.end).map(s=>s.dialogueId)
    const nearest=[...index.subtitles].sort((a,b)=>Math.min(Math.abs(a.start-time),Math.abs(a.end-time))-Math.min(Math.abs(b.start-time),Math.abs(b.end-time))).slice(0,4).map(s=>s.dialogueId)
    return {assetId,inputRevision:job.revision,currentRevision:project.revision,stale:job.result.applied===false||project.revision!==job.result.revision,time,kind,
      scene:original?{id:original.id,action:original.action,dialogue:clone(original.dialogue)}:null,activeDialogueIds:active,nearbyDialogueIds:nearest}
  }
  close(){this.closed=true;this.notifier=undefined;this.reader=undefined}
}
