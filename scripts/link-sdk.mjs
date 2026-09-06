#!/usr/bin/env node
// Explicit development-only linkage to an already installed, version-matched DSH SDK.
// Writes only this checkout's ignored node_modules; never changes the supplied SDK.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const arg=process.argv[2]
if(!arg)throw new Error('Usage: node scripts/link-sdk.mjs <installed-dsh-node_modules-or-@deepseek-ai-directory>')
let modules=path.resolve(arg)
if(path.basename(modules)==='@deepseek-ai')modules=path.dirname(modules)
const manifest=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'))
const linked=[]
for(const [name,expected] of Object.entries(manifest.devDependencies||{})){
  const source=await fs.realpath(path.join(modules,...name.split('/')))
  const pkg=JSON.parse(await fs.readFile(path.join(source,'package.json'),'utf8'))
  if(pkg.name!==name||pkg.version!==expected)throw new Error(`SDK version mismatch for ${name}: expected ${expected}, found ${pkg.version}`)
  const target=path.join(root,'node_modules',...name.split('/'))
  await fs.mkdir(path.dirname(target),{recursive:true})
  const stat=await fs.lstat(target).catch(()=>null)
  if(stat){if(await fs.realpath(target)!==source)throw new Error(`Refusing to overwrite an existing dependency: ${name}`)}
  else await fs.symlink(source,target,process.platform==='win32'?'junction':'dir')
  linked.push({name,version:pkg.version})
}
console.log(JSON.stringify({mode:'explicit-local-sdk',linked},null,2))
