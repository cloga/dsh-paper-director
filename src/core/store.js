import { DatabaseSync } from 'node:sqlite'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { clone, fail, id, newProject, normalizeAuthorPatch, probeMetadata, text } from './model.js'

const TYPES = { 'image/png':'png', 'image/jpeg':'jpg', 'image/webp':'webp', 'audio/wav':'wav', 'audio/mpeg':'mp3', 'audio/mp4':'m4a', 'audio/ogg':'ogg', 'audio/webm':'webm', 'video/mp4':'mp4' }
function sniff(bytes, mime) {
  if (mime === 'image/png') return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  if (mime === 'image/jpeg') return bytes[0]===255 && bytes[1]===216 && bytes[2]===255
  if (mime === 'image/webp') return bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP'
  if (mime === 'audio/wav') return bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WAVE'
  if (mime === 'audio/mpeg') return bytes.toString('ascii',0,3)==='ID3' || (bytes[0]===255 && (bytes[1]&224)===224)
  if (mime.endsWith('/mp4')) return bytes.toString('ascii',4,8)==='ftyp'
  if (mime === 'audio/ogg') return bytes.toString('ascii',0,4)==='OggS'
  if (mime === 'audio/webm') return bytes.subarray(0,4).equals(Buffer.from([26,69,223,163]))
  return false
}
export class ProjectStore {
  constructor({ dataDir, maxAssetBytes = 100 * 1024 * 1024, maxProjectBytes = 512 * 1024 * 1024 } = {}) {
    if (!dataDir) throw new Error('dataDir is required')
    this.root = path.resolve(dataDir); this.maxAssetBytes=maxAssetBytes; this.maxProjectBytes=maxProjectBytes
  }
  async init() {
    await fs.mkdir(this.root,{recursive:true,mode:0o700})
    this.root = await fs.realpath(this.root)
    await fs.mkdir(path.join(this.root,'assets'),{recursive:true,mode:0o700})
    this.db = new DatabaseSync(path.join(this.root,'paper-director.sqlite'))
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions(project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL, created_at TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(project_id,revision));
      CREATE TABLE IF NOT EXISTS assets(project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL, filename TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(project_id,id));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project_id);`)
    await fs.chmod(path.join(this.root,'paper-director.sqlite'),0o600)
    // A process crash is not permission to repeat a cloud call or silently finish an old revision.
    for (const row of this.db.prepare("SELECT id,document FROM jobs WHERE status IN ('queued','running')").all()) {
      const job=JSON.parse(row.document);job.status='interrupted';job.error={code:'PROCESS_RESTARTED',message:'制作任务被重启中断，请检查后重新制作。'};job.updatedAt=new Date().toISOString();this.#jobSave(job)
    }
    return this
  }
  #transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try {const result=fn();this.db.exec('COMMIT');return result} catch(e){this.db.exec('ROLLBACK');throw e} }
  #row(projectId) { id(projectId,'project id');const row=this.db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);if(!row)fail('PROJECT_NOT_FOUND','找不到这部作品。',404);return row }
  #document(projectId,revision) {const row=this.db.prepare('SELECT document FROM revisions WHERE project_id=? AND revision=?').get(projectId,revision);if(!row)fail('REVISION_NOT_FOUND','找不到这个版本。',404);return JSON.parse(row.document)}
  #save(project) {
    const encoded=JSON.stringify(project)
    if(encoded.length>5_000_000)fail('PROJECT_TOO_LARGE','作品描述过大，请减少内容。',413)
    this.db.prepare('INSERT INTO revisions(project_id,revision,created_at,document) VALUES(?,?,?,?)').run(project.id,project.revision,project.updatedAt,encoded)
    this.db.prepare('UPDATE projects SET revision=?,title=?,updated_at=? WHERE id=?').run(project.revision,project.title,project.updatedAt,project.id)
    return clone(project)
  }
  async create(input={}) {
    const project=newProject(input)
    return this.#transaction(()=>{this.db.prepare('INSERT INTO projects(id,revision,title,created_at,updated_at) VALUES(?,?,?,?,?)').run(project.id,1,project.title,project.createdAt,project.updatedAt);return this.#save(project)})
  }
  async list() {return this.db.prepare('SELECT id,revision,title,created_at AS createdAt,updated_at AS updatedAt FROM projects ORDER BY updated_at DESC').all().map(row=>({...row}))}
  async get(projectId,revision) {
    const row=this.#row(projectId)
    if(revision!==undefined&&(!Number.isSafeInteger(revision)||revision<1))fail('INVALID_REVISION','Invalid revision')
    return this.#document(projectId,revision??row.revision)
  }
  async mutate(projectId,expectedRevision,fn) {
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)fail('EXPECTED_REVISION_REQUIRED','请先刷新作品版本。',409)
    return this.#transaction(()=>{
      const row=this.#row(projectId)
      if(row.revision!==expectedRevision)fail('REVISION_CONFLICT','作品已经更新，请刷新后再修改。',409)
      const before=this.#document(projectId,row.revision)
      const updated=fn(clone(before))
      if(!updated||typeof updated.then==='function'||updated.id!==before.id)throw new Error('Internal mutation must return owned project JSON synchronously')
      updated.id=before.id;updated.createdAt=before.createdAt;updated.revision=before.revision+1;updated.updatedAt=new Date().toISOString()
      return this.#save(updated)
    })
  }
  async update(projectId,revision,patch) {return this.mutate(projectId,revision,p=>normalizeAuthorPatch(p,patch))}
  async history(projectId) {this.#row(projectId);return this.db.prepare('SELECT revision,created_at AS createdAt FROM revisions WHERE project_id=? ORDER BY revision DESC LIMIT 500').all(projectId).map(row=>({...row}))}
  async restore(projectId,expectedRevision,revision) {const previous=await this.get(projectId,revision);return this.mutate(projectId,expectedRevision,()=>clone(previous))}
  async addAsset(projectId,expectedRevision,{name,kind,mime,buffer,metadata={}}) {
    const current=await this.get(projectId)
    if(current.revision!==expectedRevision)fail('REVISION_CONFLICT','作品已经更新，请刷新后再导入。',409)
    if(!['image','audio','video'].includes(kind)||!TYPES[mime]||!(Buffer.isBuffer(buffer)||buffer instanceof Uint8Array))fail('UNSUPPORTED_MEDIA','请选择支持的图片或录音文件。',415)
    const bytes=Buffer.from(buffer)
    if(!bytes.length||bytes.length>this.maxAssetBytes)fail('ASSET_TOO_LARGE','这个文件过大或为空。',413)
    if(!sniff(bytes,mime))fail('MEDIA_TYPE_MISMATCH','文件实际格式与媒体类型不一致。',415)
    if(kind==='image'&&!mime.startsWith('image/')||kind==='audio'&&!mime.startsWith('audio/')||kind==='video'&&mime!=='video/mp4')fail('MEDIA_TYPE_MISMATCH','Invalid asset kind',415)
    if(current.assets.length>=300 || current.assets.reduce((n,a)=>n+a.bytes,0)+bytes.length>this.maxProjectBytes)fail('PROJECT_QUOTA','这部作品的素材达到容量限制。',413)
    const assetId=randomUUID(),filename=assetId+'.'+TYPES[mime]
    const directory=path.join(this.root,'assets',id(projectId));await fs.mkdir(directory,{recursive:true,mode:0o700})
    const actual=await fs.realpath(directory);if(!this.#contained(actual))fail('UNSAFE_PATH','素材目录不可用。',403)
    const file=path.join(actual,filename)
    const asset={id:assetId,name:text(name,240,'asset name','素材').replace(/[\\/]/g,'_'),kind,mime,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),metadata:probeMetadata(metadata)}
    await fs.writeFile(file,bytes,{flag:'wx',mode:0o600})
    try {
      const project=await this.mutate(projectId,expectedRevision,p=>{
        this.db.prepare('INSERT INTO assets(project_id,id,filename,document) VALUES(?,?,?,?)').run(projectId,assetId,filename,JSON.stringify(asset))
        p.assets.push(asset);return p
      })
      return {project,asset}
    } catch(e){await fs.unlink(file).catch(()=>{});throw e}
  }
  #contained(file) {const relative=path.relative(this.root,file);return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)}
  async asset(projectId,assetId) {
    this.#row(projectId);id(assetId,'asset id')
    const row=this.db.prepare('SELECT filename,document FROM assets WHERE project_id=? AND id=?').get(projectId,assetId)
    if(!row)fail('ASSET_NOT_FOUND','找不到这部作品的素材。',404)
    const file=path.join(this.root,'assets',projectId,row.filename)
    const stat=await fs.lstat(file).catch(()=>null)
    if(!stat||!stat.isFile()||stat.isSymbolicLink())fail('ASSET_UNAVAILABLE','素材文件不可用。',404)
    const actual=await fs.realpath(file)
    if(!this.#contained(actual))fail('UNSAFE_PATH','素材路径不可用。',403)
    return {...JSON.parse(row.document),path:actual}
  }
  #jobSave(job) {this.db.prepare('UPDATE jobs SET status=?,document=? WHERE id=?').run(job.status,JSON.stringify(job),job.id)}
  async jobCreate(projectId,kind,revision,input={}) {
    const p=await this.get(projectId)
    if(p.revision!==revision)fail('REVISION_CONFLICT','作品已经更新，请刷新后再制作。',409)
    const now=new Date().toISOString(),job={id:randomUUID(),projectId,kind,revision,status:'queued',progress:0,stage:'queued',createdAt:now,updatedAt:now,input:clone(input),result:null,error:null}
    this.db.prepare('INSERT INTO jobs(id,project_id,kind,revision,status,document) VALUES(?,?,?,?,?,?)').run(job.id,projectId,kind,revision,job.status,JSON.stringify(job))
    return clone(job)
  }
  async jobGet(jobId) {id(jobId,'job id');const row=this.db.prepare('SELECT document FROM jobs WHERE id=?').get(jobId);if(!row)fail('JOB_NOT_FOUND','找不到制作任务。',404);return JSON.parse(row.document)}
  async jobUpdate(jobId,patch) {const job=await this.jobGet(jobId);for(const key of Object.keys(patch))if(!['status','progress','stage','result','error'].includes(key))throw new Error('Invalid internal job field');Object.assign(job,clone(patch),{updatedAt:new Date().toISOString()});this.#jobSave(job);return clone(job)}
  async jobs(projectId) {this.#row(projectId);return this.db.prepare('SELECT document FROM jobs WHERE project_id=? ORDER BY rowid DESC LIMIT 200').all(projectId).map(r=>JSON.parse(r.document))}
  close() {this.db?.close();this.db=undefined}
}
