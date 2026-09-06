import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProjectError, fail } from './model.js'

const SCRIPT=fileURLToPath(new URL('../../python/worker.py',import.meta.url))
const STAGES=new Set(['starting','working','probe','align','audio','render','completed','error'])
const RESULT_LIMIT=8*1024*1024
const OUTPUTS=['movie.mp4','frame.png','result.json','result.tmp']
async function checkOutputs(directory,maxBytes){
  for(const name of OUTPUTS){
    let info
    try{info=await fs.lstat(path.join(directory,name))}catch(error){if(error.code==='ENOENT')continue;throw error}
    const limit=name.startsWith('result.')?RESULT_LIMIT:maxBytes
    if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>limit)throw new ProjectError('OUTPUT_LIMIT','生成文件超过允许的大小或类型。',413)
  }
}
function environment() {
  const env={}
  for(const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','HOME','USERPROFILE','LANG','LC_ALL'])if(process.env[key])env[key]=process.env[key]
  return {...env,PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1',HF_HUB_OFFLINE:'1',HUGGINGFACE_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',OMP_NUM_THREADS:'2',OPENBLAS_NUM_THREADS:'2',MKL_NUM_THREADS:'2'}
}
export class MediaWorker {
  constructor({pythonPath='python',workerTimeoutMs=300000,maxAssetBytes=100*1024*1024}={},dependencies={}) {this.pythonPath=pythonPath;this.timeout=Number.isFinite(workerTimeoutMs)?Math.max(1000,Math.min(1800000,workerTimeoutMs)):300000;this.maxAssetBytes=Number.isSafeInteger(maxAssetBytes)&&maxAssetBytes>0?maxAssetBytes:100*1024*1024;this.spawn=dependencies.spawn||spawn;this.running=new Set();this.tasks=new Set();this.waiters=[];this.busy=false;this.closed=false}
  run(request,options={}) {
    if(this.tasks.size>=32)return Promise.reject(new ProjectError('WORKER_BUSY','媒体任务太多，请稍后再试。',429))
    const task=(async()=>{const release=await this.acquire(options.signal);try{return await this.execute(request,options)}finally{release()}})()
    this.tasks.add(task);task.then(()=>this.tasks.delete(task),()=>this.tasks.delete(task));return task
  }
  acquire(signal) {
    if(this.closed)return Promise.reject(new ProjectError('SERVICE_CLOSED','制作服务已停止。',503))
    if(signal?.aborted)return Promise.reject(new ProjectError('CANCELLED','任务已取消。'))
    const release=()=>{const next=this.waiters.shift();if(next)next.grant();else this.busy=false}
    if(!this.busy){this.busy=true;return Promise.resolve(release)}
    return new Promise((resolve,reject)=>{
      const abort=()=>{this.waiters=this.waiters.filter(w=>w!==waiter);reject(new ProjectError('CANCELLED','任务已取消。'))}
      const waiter={grant:()=>{signal?.removeEventListener('abort',abort);resolve(release)},reject:()=>{signal?.removeEventListener('abort',abort);reject(new ProjectError('CANCELLED','制作服务已停止。'))}}
      this.waiters.push(waiter);signal?.addEventListener('abort',abort,{once:true})
    })
  }
  async execute(request,{signal,onProgress}={}) {
    if(this.closed)throw new ProjectError('SERVICE_CLOSED','制作服务已停止。',503)
    if(signal?.aborted)throw new ProjectError('CANCELLED','任务已取消。')
    const requestPath=path.join(request.outputDir,'request.json')
    try{
      await fs.mkdir(request.outputDir,{recursive:true,mode:0o700})
      await fs.writeFile(requestPath,JSON.stringify(request),{flag:'wx',mode:0o600})
    }catch{throw new ProjectError('MEDIA_FAILED','媒体任务无法准备，请检查工作室存储。')}
    if(this.closed||signal?.aborted)throw new ProjectError('CANCELLED','任务已取消。')
    return new Promise((resolve,reject)=>{
      let finished=false,pending='',reason=null,killTimer,settleTimer,monitoring=false
      let child
      try{child=this.spawn(this.pythonPath,['-I',SCRIPT,'--request',requestPath],{env:environment(),stdio:['ignore','pipe','pipe'],windowsHide:true})}
      catch{reject(new ProjectError('MEDIA_RUNTIME_UNAVAILABLE','媒体组件未能启动，请让家长检查Python和依赖。',503));return}
      const record={child,promise:null,stop:null};this.running.add(record)
      let resolveClosed;record.promise=new Promise(r=>resolveClosed=r)
      const cleanup=()=>{
        clearTimeout(timer);clearInterval(monitor);clearTimeout(killTimer);clearTimeout(settleTimer)
        signal?.removeEventListener('abort',abort)
        child.stdout.off('data',stdout);child.stderr.off('data',stderr)
        child.off('close',closed);child.off('error',errored)
        // A late OS error after forced teardown must not crash the Host.
        child.on('error',lateError)
        this.running.delete(record);resolveClosed()
      }
      const finishError=error=>{if(finished)return;finished=true;cleanup();reject(error)}
      const kill=signalName=>{try{child.kill(signalName)}catch{/* OS failure is bounded by forced teardown below. */}}
      const stop=error=>{
        if(finished||reason)return
        reason=error;kill('SIGTERM')
        if(finished)return
        killTimer=setTimeout(()=>{
          kill('SIGKILL')
          if(finished)return
          // SIGKILL normally produces close. Do not hang shutdown forever if a
          // broken transport/native process never acknowledges it. Fail closed:
          // never start another task while that process might still exist.
          settleTimer=setTimeout(()=>{
            this.closed=true
            for(const waiter of this.waiters.splice(0))waiter.reject()
            child.stdout.destroy();child.stderr.destroy();child.unref?.()
            finishError(reason)
          },1000)
        },2000)
      }
      record.stop=()=>stop(new ProjectError('CANCELLED','任务已取消。'))
      const abort=()=>record.stop()
      const timer=setTimeout(()=>stop(new ProjectError('WORKER_TIMEOUT','制作耗时超过限制，请缩短素材后重试。')),this.timeout)
      const monitor=setInterval(async()=>{
        if(finished||reason||monitoring)return
        monitoring=true
        try{await checkOutputs(request.outputDir,this.maxAssetBytes)}
        catch(error){stop(error instanceof ProjectError?error:new ProjectError('MEDIA_FAILED','无法检查制作输出。'))}
        finally{monitoring=false}
      },100)
      const stdout=chunk=>{
        pending+=chunk.toString('utf8')
        if(pending.length>65536)pending=pending.slice(-65536)
        let index
        while((index=pending.indexOf('\n'))>=0){const line=pending.slice(0,index);pending=pending.slice(index+1);try{const event=JSON.parse(line);if(Number.isFinite(event.progress))onProgress?.({progress:Math.max(0,Math.min(1,event.progress)),stage:STAGES.has(event.stage)?event.stage:'working'})}catch{/* No worker messages or arbitrary stages become public logs. */}}
      }
      const stderr=()=>{} // Drain, but never retain process diagnostics/credentials.
      const lateError=()=>{}
      const errored=()=>{
        const error=new ProjectError('MEDIA_RUNTIME_UNAVAILABLE','媒体组件未能启动，请让家长检查Python和依赖。',503)
        if(child.pid)stop(error)
        else finishError(error)
      }
      const closed=async code=>{
        if(finished)return;finished=true;cleanup()
        if(reason)return reject(reason)
        if(signal?.aborted||this.closed)return reject(new ProjectError('CANCELLED','任务已取消。'))
        try {
          await checkOutputs(request.outputDir,this.maxAssetBytes)
          const payload=JSON.parse((await readBoundedOutput(path.join(request.outputDir,'result.json'),RESULT_LIMIT)).toString('utf8'))
          if(code!==0||payload.ok!==true){const error=payload.error||{};return reject(new ProjectError(typeof error.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)?error.code:'MEDIA_FAILED',safeMessage(error.message,'媒体处理失败，请检查素材或制作设置。')))}
          if(!payload.result||typeof payload.result!=='object'||Array.isArray(payload.result))throw new Error('Invalid result')
          resolve(payload.result)
        } catch(error){reject(error instanceof ProjectError&&error.code==='OUTPUT_LIMIT'?error:new ProjectError('MEDIA_FAILED',code===0?'媒体组件没有返回有效结果。':'媒体处理失败，请检查组件、素材格式或字体设置。'))}
      }
      child.stdout.on('data',stdout);child.stderr.on('data',stderr)
      child.once('error',errored);child.once('close',closed)
      signal?.addEventListener('abort',abort,{once:true})
      if(signal?.aborted||this.closed)record.stop()
    })
  }
  async close(){this.closed=true;for(const waiter of this.waiters.splice(0))waiter.reject();for(const r of this.running)r.stop();await Promise.allSettled([...this.tasks])}
}
export function safeMessage(value,fallback='操作没有完成，请重试或检查设置。') {
  if(typeof value!=='string')return fallback
  // Do not expose process paths, stack traces, environment values or transport credentials.
  if(/(?:[\\/]|[\u0000-\u001f\u007f]|Traceback|Authorization|Subscription-Key|Bearer\s|\b(?:token|secret|password|api[_ -]?key)\s*["']?\s*[:=]|\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+)/i.test(value))return fallback
  return value.slice(0,600)
}
export async function resolveWorkerOutput(outputDir,filename) {
  if(typeof filename!=='string'||!/^[A-Za-z0-9_-]+\.(mp4|png|wav|json)$/.test(filename))fail('INVALID_WORKER_OUTPUT','制作结果路径不合法。')
  const file=path.join(outputDir,filename),stat=await fs.lstat(file)
  if(!stat.isFile()||stat.isSymbolicLink())fail('INVALID_WORKER_OUTPUT','制作结果不是普通文件。')
  const root=await fs.realpath(outputDir),actual=await fs.realpath(file)
  if(path.dirname(actual)!==root)fail('INVALID_WORKER_OUTPUT','制作结果越出了任务目录。')
  return actual
}
export async function readBoundedOutput(file,maxBytes){
  const info=await fs.lstat(file)
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>maxBytes)fail('OUTPUT_LIMIT','生成文件超过允许的大小或类型。',413)
  const handle=await fs.open(file,'r');let total=0;const chunks=[]
  try{
    const stat=await handle.stat();if(!stat.isFile()||stat.size>maxBytes)fail('OUTPUT_LIMIT','生成文件超过允许的大小。',413)
    for(;;){const buffer=Buffer.allocUnsafe(65536);const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;if(total>maxBytes)fail('OUTPUT_LIMIT','生成文件超过允许的大小。',413);chunks.push(buffer.subarray(0,bytesRead))}
    return Buffer.concat(chunks,total)
  }finally{await handle.close()}
}
