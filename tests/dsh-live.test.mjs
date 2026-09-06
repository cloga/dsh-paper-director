import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp,rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'

const sdk=existsSync(new URL('../node_modules/@deepseek-ai/cordis/package.json',import.meta.url))
test('actual Cordis mounts/unmounts the real Host service and releases storage/route ownership',{skip:!sdk?'Explicit matching local SDK link is required':false},async()=>{
 const {Context}=await import('@deepseek-ai/cordis')
 const {default:PaperDirector}=await import('../index.js')
 const {ProjectStore}=await import('../src/core/store.js')
 const root=await mkdtemp(path.join(tmpdir(),'paper-live-cordis-')),ctx=new Context(),routes=[]
 let plugin,carrier
 try{
  carrier=ctx.plugin({name:'test-http-carrier',apply(c){
   c.provide('webServer',{register(route){routes.push(route);return ()=>{const i=routes.indexOf(route);if(i>=0)routes.splice(i,1)}}})
   c.provide('connection',{requestRejection(req){return req.headers.cookie==='fixture=authenticated'?undefined:401}})
  }})
  await carrier
  plugin=ctx.plugin(PaperDirector,{dataDir:root})
  await plugin
  const service=ctx.get('paperDirector');assert.ok(service);assert.equal(service.core.initialized,true)
  assert.equal(routes.length,2)
  const p=await service.dispatch('project.create',{title:'真实Cordis加载测试'})
  assert.equal((await service.dispatch('project.get',{}, {projectId:p.id})).title,p.title)
  let status,body
  const response={writeHead(s){status=s},end(value){body=value}}
  await routes[0].handler({headers:{},url:'/paper-director/'},response)
  assert.equal(status,401);assert.equal(JSON.parse(body).error.code,'AUTH_REQUIRED')
  await plugin.dispose();plugin=null
  assert.equal(ctx.get('paperDirector'),undefined);assert.equal(routes.length,0);assert.equal(service.core.closed,true)
  const reopened=await new ProjectStore({dataDir:root}).init();assert.equal((await reopened.get(p.id)).title,p.title);reopened.close()
 }finally{await plugin?.dispose();await carrier?.dispose();await rm(root,{recursive:true,force:true})}
})
