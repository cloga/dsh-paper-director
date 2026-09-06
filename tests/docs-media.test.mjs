import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile,stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
const ROOT=fileURLToPath(new URL('../',import.meta.url)),MEDIA=path.join(ROOT,'docs','media')
function gifInfo(bytes){
 assert.match(bytes.toString('ascii',0,6),/^GIF8[79]a$/)
 const width=bytes.readUInt16LE(6),height=bytes.readUInt16LE(8)
 let p=13+(bytes[10]&128?3*2**((bytes[10]&7)+1):0),delay=0,frames=0,duration=0
 const blocks=()=>{for(;;){assert.ok(p<bytes.length);const n=bytes[p++];if(!n)return;p+=n;assert.ok(p<=bytes.length)}}
 while(p<bytes.length){const type=bytes[p++];if(type===0x3b)break
  if(type===0x21){const label=bytes[p++];if(label===0xf9){assert.equal(bytes[p++],4);delay=bytes.readUInt16LE(p+1)*10;p+=4;assert.equal(bytes[p++],0)}else blocks()}
  else if(type===0x2c){const packed=bytes[p+8];p+=9;if(packed&128)p+=3*2**((packed&7)+1);p++;blocks();frames++;duration+=delay;delay=0}
  else assert.fail('Unexpected GIF block')
 }
 return {width,height,frames,duration}
}
test('documentation images match reviewed metadata and the short GIF contract',async()=>{
 const manifest=JSON.parse(await readFile(path.join(MEDIA,'manifest.json'),'utf8'))
 assert.equal(manifest.license,'MIT');assert.equal(manifest.files.length,7)
 let total=0
 for(const entry of manifest.files){
  assert.match(entry.file,/^[a-z-]+\.(png|gif)$/)
  const bytes=await readFile(path.join(MEDIA,entry.file));total+=bytes.length
  assert.equal(bytes.length,entry.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256)
  assert.equal(entry.width,1000)
  if(entry.format==='PNG'){assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(bytes.readUInt32BE(16),entry.width);assert.equal(bytes.readUInt32BE(20),entry.height)}
  else{const info=gifInfo(bytes);assert.equal(info.width,entry.width);assert.equal(info.height,entry.height);assert.equal(info.frames,entry.frames);assert.equal(info.duration,entry.duration_ms);assert.ok(info.duration>=3000&&info.duration<=8000);assert.ok(bytes.length<2*1024*1024)}
 }
 assert.ok(total<2*1024*1024,'Documentation media should stay lightweight')
})
const slug=text=>text.toLowerCase().replace(/[`*_]/g,'').replace(/[^\p{L}\p{N}\s_-]/gu,'').trim().replace(/\s/g,'-')
test('visual guide links and explicit navigation anchors resolve within the repository',async()=>{
 const names=['README.md','docs/quick-start.md','docs/install.md','docs/media/README.md']
 for(const name of names){const file=path.join(ROOT,name),text=await readFile(file,'utf8')
  for(const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)){
   const target=match[1].split(/\s+"/)[0];if(/^(?:https?:|mailto:)/.test(target))continue
   const [relative,anchor]=target.split('#');const absolute=relative?path.resolve(path.dirname(file),decodeURIComponent(relative)):file
   assert.ok(absolute.startsWith(ROOT),`Link escapes repository: ${name}: ${target}`)
   assert.ok((await stat(absolute)).isFile(),`${name}: ${target}`)
   if(anchor&&absolute.endsWith('.md')){
    const body=await readFile(absolute,'utf8'),ids=new Set([...body.matchAll(/<a\s+id="([^"]+)"/g)].map(m=>m[1]))
    for(const h of body.matchAll(/^#{1,6}\s+(.+)$/gm))ids.add(slug(h[1]))
    assert.ok(ids.has(decodeURIComponent(anchor)),`Unknown anchor ${name}: ${target}`)
   }
  }
 }
})
