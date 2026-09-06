import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, writeFile, rm, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MediaWorker, safeMessage, readBoundedOutput } from '../src/core/worker.js'

async function fixture(t, config = {}, onSpawn = () => {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'paper-worker-resource-'))
  const children = [], commands = []
  let notify
  let arrival = new Promise(resolve => { notify = resolve })
  const worker = new MediaWorker({ maxAssetBytes: 32, ...config }, { spawn(...args) {
    const child = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 12345
    child.signals = []; child.kill = signal => { child.signals.push({ signal, at: Date.now() }); if (signal === 'SIGKILL' || child.cooperative) queueMicrotask(() => child.emit('close', 1)); return true }
    child.unref = () => {}
    children.push(child); commands.push(args)
    onSpawn(child, args)
    notify(child)
    return child
  } })
  t.after(async () => { await worker.close(); await rm(root, { recursive: true, force: true }) })
  let sequence = 0
  return { root, worker, children, commands,
    request: () => ({ action: 'render', outputDir: path.join(root, `job-${sequence++}`) }),
    started: () => arrival,
    resetArrival() { arrival = new Promise(resolve => { notify = resolve }) },
  }
}
const outcome = promise => promise.then(value => ({ value }), error => ({ error }))
const code = (result, expected) => assert.equal(result.error?.code, expected, result.error?.message)

for (const name of ['movie.mp4', 'frame.png', 'result.json', 'result.tmp']) {
  test(`owned ${name} is stopped during production when its byte limit is exceeded`, async t => {
    const f = await fixture(t, {}, child => { child.cooperative = true })
    const request = f.request(), result = outcome(f.worker.run(request))
    const child = await f.started()
    if (name.startsWith('result.')) {
      // Sparse truncate exercises the real fixed 8 MiB limit without allocating it.
      const file = await open(path.join(request.outputDir, name), 'w')
      await file.truncate(8 * 1024 * 1024 + 1); await file.close()
    } else await writeFile(path.join(request.outputDir, name), Buffer.alloc(33))
    code(await result, 'OUTPUT_LIMIT')
    assert.deepEqual(child.signals.map(s => s.signal), ['SIGTERM'])
    assert.equal(f.worker.running.size, 0); assert.equal(f.worker.tasks.size, 0)
    assert.equal(child.stdout.listenerCount('data'), 0)
  })
}

test('final output check catches a fast oversized producer before polling and preserves bounded reader', async t => {
  const f = await fixture(t)
  const request = f.request(), result = outcome(f.worker.run(request))
  const child = await f.started()
  await writeFile(path.join(request.outputDir, 'movie.mp4'), Buffer.alloc(33))
  await writeFile(path.join(request.outputDir, 'result.json'), JSON.stringify({ ok: true, result: { path: 'movie.mp4' } }))
  child.emit('close', 0)
  code(await result, 'OUTPUT_LIMIT')
  await assert.rejects(readBoundedOutput(path.join(request.outputDir, 'movie.mp4'), 32), error => error.code === 'OUTPUT_LIMIT')
  await writeFile(path.join(request.outputDir, 'small.bin'), 'safe')
  assert.equal((await readBoundedOutput(path.join(request.outputDir, 'small.bin'), 4)).toString(), 'safe')
})

test('only fixed owned outputs are monitored; successful worker retains fixed CLI and sanitized progress', async t => {
  const f = await fixture(t)
  const request = f.request(), events = []
  const controller = new AbortController()
  const result = outcome(f.worker.run(request, { signal: controller.signal, onProgress: e => events.push(e) }))
  const child = await f.started()
  assert.equal(f.commands[0][1][0], '-I')
  assert.equal(f.commands[0][1][2], '--request')
  assert.equal(f.commands[0][2].shell, undefined)
  assert.equal(f.commands[0][2].env.HF_HUB_OFFLINE, '1')
  for (const stage of ['render', '/srv/private/model', 'token=synthetic', 'align']) child.stdout.write(JSON.stringify({ progress: 2, stage, message: 'must not be forwarded' }) + '\n')
  assert.deepEqual(events, [{ progress: 1, stage: 'render' }, { progress: 1, stage: 'working' }, { progress: 1, stage: 'working' }, { progress: 1, stage: 'align' }])
  await writeFile(path.join(request.outputDir, 'not-owned.bin'), Buffer.alloc(100))
  await writeFile(path.join(request.outputDir, 'movie.mp4'), Buffer.alloc(32))
  await writeFile(path.join(request.outputDir, 'result.json'), JSON.stringify({ ok: true, result: { path: 'movie.mp4' } }))
  child.emit('close', 0)
  assert.deepEqual((await result).value, { path: 'movie.mp4' })
  assert.deepEqual(child.signals, [])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.equal(child.listenerCount('close'), 0)
})

for (const reason of ['cancel', 'timeout', 'close']) {
  test(`${reason} uses TERM then KILL after two seconds and releases serialized waiters`, { timeout: 10000 }, async t => {
    const f = await fixture(t, { workerTimeoutMs: reason === 'timeout' ? 1000 : 20000 })
    const controller = new AbortController()
    const result = outcome(f.worker.run(f.request(), { signal: controller.signal }))
    const child = await f.started()
    let closing
    if (reason === 'cancel') controller.abort()
    if (reason === 'close') closing = f.worker.close()
    code(await result, reason === 'timeout' ? 'WORKER_TIMEOUT' : 'CANCELLED')
    await closing
    assert.deepEqual(child.signals.map(s => s.signal), ['SIGTERM', 'SIGKILL'])
    assert.ok(child.signals[1].at - child.signals[0].at >= 1900)
    assert.equal(f.worker.running.size, 0); assert.equal(f.worker.tasks.size, 0)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    assert.equal(child.stdout.listenerCount('data'), 0)
  })
}

test('unacknowledged SIGKILL cannot hang close and prevents new worker tasks', { timeout: 10000 }, async t => {
  const f = await fixture(t, {}, child => { child.kill = signal => { child.signals.push({ signal, at: Date.now() }); return false } })
  const result = outcome(f.worker.run(f.request()))
  const child = await f.started()
  const waiting = outcome(f.worker.run(f.request()))
  await f.worker.close()
  code(await result, 'CANCELLED'); code(await waiting, 'CANCELLED')
  assert.deepEqual(child.signals.map(s => s.signal), ['SIGTERM', 'SIGKILL'])
  assert.equal(f.worker.closed, true)
  assert.equal(f.worker.running.size, 0); assert.equal(f.worker.tasks.size, 0)
  code(await outcome(f.worker.run(f.request())), 'SERVICE_CLOSED')
})

test('generic preparation/spawn/process errors and malicious worker diagnostics are sanitized', async t => {
  const f = await fixture(t)
  const blocked = path.join(f.root, 'not-a-directory')
  await writeFile(blocked, 'x')
  const failed = await outcome(f.worker.run({ action: 'health', outputDir: path.join(blocked, 'private') }))
  code(failed, 'MEDIA_FAILED'); assert.ok(!failed.error.message.includes(f.root))
  f.worker.spawn = () => { throw new Error('token=synthetic-secret /srv/private') }
  code(await outcome(f.worker.run(f.request())), 'MEDIA_RUNTIME_UNAVAILABLE')
  for (const text of ['/tmp/private/a', '/srv/private/a', '/var/private/', '/root', '\\\\host\\private', 'C:\\private\\a', 'token=synthetic', '"api_key": "synthetic"', 'Authorization: Bearer synthetic', 'github_pat_synthetic_value', 'Traceback private']) {
    assert.equal(safeMessage(text, 'redacted'), 'redacted')
  }
  assert.equal(safeMessage('字幕太长，请缩短台词。'), '字幕太长，请缩短台词。')
})

test('worker result errors reject unsafe code and messages; queued cancellation does not spawn', async t => {
  const f = await fixture(t)
  const first = f.request(), result = outcome(f.worker.run(first))
  const child = await f.started()
  const controller = new AbortController()
  const waiting = outcome(f.worker.run(f.request(), { signal: controller.signal }))
  controller.abort()
  code(await waiting, 'CANCELLED'); assert.equal(f.children.length, 1)
  await writeFile(path.join(first.outputDir, 'result.json'), JSON.stringify({ ok: false, error: { code: '/srv/private', message: 'token=synthetic-secret' } }))
  child.emit('close', 1)
  const failed = await result
  code(failed, 'MEDIA_FAILED'); assert.ok(!failed.error.message.includes('synthetic'))
  assert.equal(f.worker.waiters.length, 0)
})
