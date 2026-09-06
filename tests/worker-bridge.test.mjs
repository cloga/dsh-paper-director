import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { MediaWorker } from '../src/core/worker.js'

const local=path.resolve(process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python')
const python=process.env.PAPER_DIRECTOR_TEST_PYTHON || (existsSync(local)?local:undefined)
test('real isolated Python worker reports health without leaking host paths',{skip:!python?'Set PAPER_DIRECTOR_TEST_PYTHON or prepare .venv':false},async()=>{
  const output=await mkdtemp(path.join(tmpdir(),'paper-worker-health-'))
  const worker=new MediaWorker({pythonPath:python,workerTimeoutMs:20000})
  try {
    const result=await worker.run({action:'health',outputDir:output})
    assert.equal(result.networkEnabled,false)
    assert.equal(result.automaticModelDownload,false)
    assert.equal(result.dependencies.av,true)
    assert.equal(result.codecs.libx264,true)
    assert.equal(result.ready,true)
    assert.ok(!JSON.stringify(result).includes(output))
  } finally {await worker.close();await rm(output,{recursive:true,force:true})}
})
