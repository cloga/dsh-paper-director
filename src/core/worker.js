import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProjectError, fail } from './model.js'

const SCRIPT=fileURLToPath(new URL('../../python/worker.py',import.meta.url))
function environment() {
  const env={}
  for(const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','HOME','USERPROFILE','LANG','LC_ALL'])if(process.env[key])env[key]=process.env[key]
  return {...env,PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1',HF_HUB_OFFLINE:'1',HUGGINGFACE_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',OMP_NUM_THREADS:'2',OPENBLAS_NUM_THREADS:'2',MKL_NUM_THREADS:'2'}
}
export class MediaWorker {
  constructor({pythonPath='python',workerTimeoutMs=300000}={}) {this.pythonPath=pythonPath;this.timeout=Math.max(1000,Math.min(1800000,workerTimeoutMs));this.running=new Set();this.closed=false}
  async run(request,{signal,onProgress}={}) {
    if(this.closed)throw new ProjectError('SERVICE_CLOSED','制作服务已停止。',503)
    if(signal?.aborted)throw new ProjectError('CANCELLED','任务已取消。')
    await fs.mkdir(request.outputDir,{recursive:true,mode:0o700})
    const requestPath=path.join(request.outputDir,'request.json')
    await fs.writeFile(requestPath,JSON.stringify(request),{flag:'wx',mode:0o600})
    return new Promise((resolve,reject)=>{
      let finished=false,timedOut=false,pending='',stderr=''
      const child=spawn(this.pythonPath,['-I',SCRIPT,'--request',requestPath],{env:environment(),stdio:['ignore','pipe','pipe'],windowsHide:true})
      const record={child,promise:null};this.running.add(record)
      let resolveClosed;record.promise=new Promise(r=>resolveClosed=r)
      const abort=()=>child.kill('SIGTERM')
      signal?.addEventListener('abort',abort,{once:true})
      const timer=setTimeout(()=>{timedOut=true;abort()},this.timeout)
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.running.delete(record);resolveClosed()}
      child.stdout.on('data',chunk=>{
        pending+=chunk.toString('utf8')
        if(pending.length>65536)pending=pending.slice(-65536)
        let index
        while((index=pending.indexOf('\n'))>=0){const line=pending.slice(0,index);pending=pending.slice(index+1);try{const event=JSON.parse(line);if(Number.isFinite(event.progress))onProgress?.({progress:Math.max(0,Math.min(1,event.progress)),stage:typeof event.stage==='string'?event.stage.slice(0,80):'working'})}catch{/* Non-progress output never becomes user-visible logs. */}}
      })
      child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString('utf8')).slice(-8000)})
      child.once('error',()=>{if(finished)return;finished=true;cleanup();reject(new ProjectError('MEDIA_RUNTIME_UNAVAILABLE','媒体组件未能启动，请让家长检查Python和依赖。',503))})
      child.once('close',async code=>{
        if(finished)return;finished=true;cleanup()
        if(signal?.aborted||this.closed)return reject(new ProjectError('CANCELLED','任务已取消。'))
        if(timedOut)return reject(new ProjectError('WORKER_TIMEOUT','制作耗时超过限制，请缩短素材后重试。'))
        try {
          const resultPath=path.join(request.outputDir,'result.json')
          const stat=await fs.lstat(resultPath)
          if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024)throw new Error('Invalid result')
          const payload=JSON.parse(await fs.readFile(resultPath,'utf8'))
          if(code!==0||payload.ok!==true){const error=payload.error||{};return reject(new ProjectError(typeof error.code==='string'?error.code:'MEDIA_FAILED',safeMessage(error.message,'媒体处理失败，请检查素材或制作设置。')))}
          if(!payload.result||typeof payload.result!=='object')throw new Error('Invalid result')
          resolve(payload.result)
        } catch {reject(new ProjectError('MEDIA_FAILED',code===0?'媒体组件没有返回有效结果。':'媒体处理失败，请检查组件、素材格式或字体设置。'))}
      })
    })
  }
  async close(){this.closed=true;const entries=[...this.running];for(const r of entries)r.child.kill('SIGTERM');await Promise.all(entries.map(r=>r.promise))}
}
export function safeMessage(value,fallback='操作没有完成，请重试或检查设置。') {
  if(typeof value!=='string')return fallback
  // Do not expose process paths, stack traces, environment values or transport credentials.
  if(/(?:[A-Za-z]:[\\/]|\/home\/|\/Users\/|Traceback|Authorization|Subscription-Key|Bearer )/i.test(value))return fallback
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
