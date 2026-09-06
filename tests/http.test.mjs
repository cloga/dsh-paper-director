import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleRequest } from '../src/http.js'
import { ProjectError } from '../src/core/model.js'

const BASE = '/paper-director'
const PROJECT = `${BASE}/api/projects/story`

// These stubs assert the exact Core boundary without requiring the concurrently
// implemented service/Python worker. The only server is an ephemeral test fixture.
async function fixture(t, overrides = {}) {
  const calls = []
  const dir = await mkdtemp(join(tmpdir(), 'paper-http-test-'))
  const media = join(dir, 'synthetic.bin')
  await writeFile(media, '0123456789')
  const core = {
    config: { maxAssetBytes: 32 },
    async dispatch(operation, args, scope) { calls.push({ operation, args, scope }); return { operation, args } },
    async health() { calls.push({ operation: 'health' }); return { version: '0.1.0', render: { ready: false } } },
    async importAsset(projectId, expectedRevision, input) {
      assert.deepEqual(Object.keys(input).sort(), ['buffer', 'kind', 'name'])
      assert.ok(Buffer.isBuffer(input.buffer))
      calls.push({ operation: 'importAsset', projectId, expectedRevision, input })
      return { project: { id: projectId, revision: expectedRevision + 1 }, asset: { id: 'asset', mime: 'audio/wav' } }
    },
    async asset(projectId, assetId) { calls.push({ operation: 'asset', projectId, assetId }); return { path: media, mime: 'video/mp4', bytes: 10 } },
    async startAgent(args) { calls.push({ operation: 'startAgent', args }); return { sessionId: 'session-test' } },
    ...overrides,
  }
  const server = http.createServer((req, res) => { handleRequest(core, req, res).catch(() => res.destroy()) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    await rm(dir, { recursive: true, force: true })
  })
  const port = server.address().port
  async function request(path, { method = 'GET', body, raw, chunks, headers = {} } = {}) {
    if (body !== undefined) { raw = JSON.stringify(body); headers = { 'content-type': 'application/json', ...headers } }
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, res => {
        const buffers = []
        res.on('data', b => buffers.push(b))
        res.on('end', () => {
          const text = Buffer.concat(buffers).toString()
          let envelope
          try { envelope = JSON.parse(text) } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, envelope })
        })
      })
      req.on('error', reject)
      if (chunks) for (const chunk of chunks) req.write(chunk)
      req.end(raw)
    })
  }
  return { request, calls, core, media, port, server }
}
function ok(response) { assert.equal(response.status, 200); assert.equal(response.envelope.ok, true); return response.envelope.data }
function denied(response, status, code) {
  assert.equal(response.status, status, response.text)
  assert.equal(response.envelope.ok, false)
  if (code) assert.equal(response.envelope.error.code, code)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.headers['access-control-allow-origin'], undefined)
}

test('project/list/create/get/PATCH/history/restore use exact dispatch names and projectId args', async t => {
  const { request, calls } = await fixture(t)
  const author = { title: '纸上故事', story: '自己写的故事', credits: { director: '导演', voice: '声音' } }
  const cases = [
    [`${BASE}/api/projects`, {}, 'project.list', {}],
    [`${BASE}/api/projects`, { method: 'POST', body: author }, 'project.create', author],
    [PROJECT, {}, 'project.get', { projectId: 'story' }],
    [PROJECT, { method: 'PATCH', body: { expectedRevision: 1, patch: { title: '新标题' } } }, 'project.update', { projectId: 'story', expectedRevision: 1, patch: { title: '新标题' } }],
    [`${PROJECT}/history`, {}, 'project.history', { projectId: 'story' }],
    [`${PROJECT}/restore`, { method: 'POST', body: { expectedRevision: 2, revision: 1 } }, 'project.restore', { projectId: 'story', expectedRevision: 2, revision: 1 }],
  ]
  for (const [path, options, operation, args] of cases) {
    ok(await request(path, options))
    assert.deepEqual(calls.at(-1), { operation, args, scope: undefined })
  }
})

test('alignment/render/narration/edits/jobs map to Core without model scope or human starter dispatch', async t => {
  const { request, calls } = await fixture(t)
  const operation = { type: 'shorten_pause', afterDialogueId: 'line1', beforeDialogueId: 'line2', targetSeconds: .5 }
  const segments = [{ dialogueId: 'line1', start: 0, end: 1, text: '原台词' }, { start: 1, end: 2, text: '额外的话' }]
  const cases = [
    [`${PROJECT}/align`, { expectedRevision: 2 }, 'recording.align'],
    [`${PROJECT}/align`, { expectedRevision: 2, engine: 'segments', segments }, 'recording.align'],
    [`${PROJECT}/render`, { expectedRevision: 2, preview: false }, 'movie.render'],
    [`${PROJECT}/narration`, { expectedRevision: 2, text: '旁白', voiceProfile: 'narrator' }, 'narration.generate'],
    [`${PROJECT}/edits`, { expectedRevision: 2, operation }, 'timeline.propose'],
    [`${PROJECT}/edits`, { expectedRevision: 2, operation, apply: true, allowUnmatchedSpeech: true }, 'timeline.apply'],
  ]
  for (const [path, body, op] of cases) {
    ok(await request(path, { method: 'POST', body }))
    const { apply, ...args } = body
    assert.deepEqual(calls.at(-1), { operation: op, args: { projectId: 'story', ...args }, scope: undefined })
  }
  ok(await request(`${BASE}/api/jobs?projectId=story`))
  assert.deepEqual(calls.at(-1), { operation: 'job.list', args: { projectId: 'story' }, scope: undefined })
  ok(await request(`${BASE}/api/jobs/job1`))
  assert.deepEqual(calls.at(-1), { operation: 'job.get', args: { jobId: 'job1' }, scope: undefined })
  ok(await request(`${BASE}/api/jobs/job1/cancel`, { method: 'POST', body: {} }))
  assert.deepEqual(calls.at(-1), { operation: 'job.cancel', args: { jobId: 'job1' }, scope: undefined })
  assert.deepEqual(ok(await request(`${PROJECT}/agent`, { method: 'POST', body: { expectedRevision: 2, prompt: '请开始制作' } })), { sessionId: 'session-test' })
  assert.deepEqual(calls.at(-1), { operation: 'startAgent', args: { projectId: 'story', expectedRevision: 2, prompt: '请开始制作' } })
})

test('static allowlist, redirect, HEAD, private ETag revalidation and security headers', async t => {
  const { request, calls } = await fixture(t)
  const redirect = await request(BASE)
  assert.equal(redirect.status, 308)
  assert.equal(redirect.headers.location, `${BASE}/`)
  for (const path of [`${BASE}/`, `${BASE}/static/studio.js`, `${BASE}/static/studio.css`]) {
    const result = await request(path)
    assert.equal(result.status, 200)
    assert.ok(result.text.length)
    assert.equal(result.headers['cache-control'], 'private, no-cache, must-revalidate')
    assert.equal(result.headers['x-content-type-options'], 'nosniff')
    assert.equal(result.headers['cross-origin-resource-policy'], 'same-origin')
    assert.match(result.headers['content-security-policy'], /object-src 'none'/)
    const head = await request(path, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.text, '')
    assert.equal(head.headers['content-length'], result.headers['content-length'])
    const conditional = await request(path, { headers: { 'if-none-match': `W/${result.headers.etag}` } })
    assert.equal(conditional.status, 304)
    assert.equal(conditional.text, '')
  }
  assert.equal(calls.length, 0)
  assert.equal(ok(await request(`${BASE}/api/health`)).render.ready, false)
  const apiHead = await request(PROJECT, { method: 'HEAD' })
  assert.equal(apiHead.status, 200)
  assert.equal(apiHead.text, '')
  assert.equal(apiHead.headers['cache-control'], 'no-store')
})

test('raw traversal, percent encodings, malformed identities, unknown paths and query smuggling never reach core', async t => {
  const { request, calls } = await fixture(t)
  const paths = [
    `${BASE}/static/../index.js`, `${BASE}/static/%2e%2e/index.js`, `${BASE}/static/%252e%252e/index.js`,
    `${BASE}/static/..\\index.js`, `${BASE}//static/studio.js`, `${BASE}/api/projects/%2fetc`,
    `${BASE}/api/projects/%00`, `${BASE}/api/projects/a.b`, `${BASE}/api/projects/${'x'.repeat(65)}`,
    `${BASE}/api/projects/story?projectId=other`, `${BASE}/api/jobs?projectId=story&projectId=other`,
    `${BASE}/api/jobs?projectId=%252e`, `${BASE}/api/jobs?projectId=%QQ`, `${BASE}/api/jobs`,
  ]
  for (const path of paths) denied(await request(path), 400)
  for (const path of ['/outside', `${BASE}/static/index.js`, `${BASE}/static/index.html`, `${BASE}/api/projects/story/history/extra`, `${BASE}/api/dispatch`, `${BASE}/api/projects/story/unknown`]) denied(await request(path), 404)
  assert.equal(calls.length, 0)
})

test('method allowlists and unexpected read bodies reject before core work', async t => {
  const { request, calls } = await fixture(t)
  for (const [path, method, allow] of [
    [`${BASE}/static/studio.js`, 'POST', 'GET, HEAD'], [PROJECT, 'DELETE', 'GET, HEAD, PATCH'],
    [`${PROJECT}/agent`, 'GET', 'POST'], [`${PROJECT}/assets/asset`, 'PUT', 'GET, HEAD'],
    [`${PROJECT}/assets`, 'GET', 'POST'], [`${BASE}/api/jobs/job1/cancel`, 'GET', 'POST'],
    [`${BASE}/api/projects`, 'OPTIONS', 'GET, HEAD, POST'],
  ]) {
    const result = await request(path, { method })
    denied(result, 405, 'METHOD_NOT_ALLOWED'); assert.equal(result.headers.allow, allow)
  }
  denied(await request(PROJECT, { raw: 'junk', headers: { 'content-length': '4' } }), 400, 'UNEXPECTED_BODY')
  assert.equal(calls.length, 0)
})

test('CSRF defense rejects hostile origins/fetch metadata and simple or compressed JSON types', async t => {
  const { request, calls, port } = await fixture(t)
  for (const origin of ['null', 'http://evil.invalid', `https://127.0.0.1:${port}`, `http://127.0.0.1:${port}.evil.invalid`, `http://127.0.0.1:${port}/path`]) denied(await request(PROJECT, { headers: { origin } }), 403, 'FORBIDDEN')
  for (const site of ['cross-site', 'same-site']) denied(await request(`${BASE}/`, { headers: { 'sec-fetch-site': site } }), 403)
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp', 'application/json; charset=latin1', '']) {
    denied(await request(`${BASE}/api/projects`, { method: 'POST', raw: '{}', headers: { 'content-type': type } }), 415, 'UNSUPPORTED_CONTENT_TYPE')
  }
  denied(await request(`${BASE}/api/projects`, { method: 'POST', body: {}, headers: { 'content-encoding': 'gzip' } }), 415)
  assert.equal(calls.length, 0)
  ok(await request(`${BASE}/api/projects`, { method: 'POST', body: {}, headers: { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json; charset=UTF-8' } }))
})

test('JSON size is bounded for Content-Length and chunked uploads; bad JSON/UTF-8 is rejected', async t => {
  const { request, calls } = await fixture(t)
  denied(await request(`${BASE}/api/projects`, { method: 'POST', raw: '{}', headers: { 'content-type': 'application/json', 'content-length': String(1024 * 1024 + 1) } }), 413, 'BODY_TOO_LARGE')
  denied(await request(`${BASE}/api/projects`, { method: 'POST', chunks: [Buffer.alloc(600000, 32), Buffer.alloc(600000, 32)], headers: { 'content-type': 'application/json' } }), 413, 'BODY_TOO_LARGE')
  for (const raw of ['', '{', 'null', '[]', '"hello"', Buffer.from([0xff, 0xfe])]) denied(await request(`${BASE}/api/projects`, { method: 'POST', raw, headers: { 'content-type': 'application/json' } }), 400)
  assert.equal(calls.length, 0)
  ok(await request(`${BASE}/api/projects`, { method: 'POST', raw: '{}'.padEnd(1024 * 1024, ' '), headers: { 'content-type': 'application/json', 'content-length': String(1024 * 1024) } }))
})

test('aborted partial uploads do not dispatch, crash or prevent subsequent requests', async t => {
  const { request, calls, port, server } = await fixture(t)
  let received
  const arrival = new Promise(resolve => server.once('request', req => { received = req; resolve() }))
  const outgoing = http.request({ hostname: '127.0.0.1', port, path: `${PROJECT}/assets`, method: 'POST', headers: { ...uploadHeaders, 'content-length': '20' } })
  outgoing.on('error', () => {})
  outgoing.write('partial')
  await arrival
  const aborted = new Promise(resolve => received.once('aborted', resolve))
  outgoing.destroy()
  await aborted
  assert.equal(calls.length, 0)
  ok(await request(PROJECT))
})

test('unknown fields, nested prototype payloads, untrusted model paths and invalid mutations are rejected', async t => {
  const { request, calls } = await fixture(t)
  const invalid = [
    [`${BASE}/api/projects`, { title: 'ok', path: '/not-an-upload' }],
    [`${BASE}/api/projects`, { credits: { director: 'x', secret: 'no' } }],
    [`${BASE}/api/projects`, { characters: [{ name: 'x', model: 'evil' }] }],
    [`${BASE}/api/projects`, { scenes: [{ action: '', command: 'evil' }] }],
    [`${BASE}/api/projects`, { scenes: [{ dialogue: [{ characterId: 'narrator', text: 'x', path: 'evil' }] }] }],
    [`${PROJECT}/align`, { expectedRevision: 1, modelPath: 'untrusted' }],
    [`${PROJECT}/align`, { expectedRevision: 1, engine: 'cloud' }],
    [`${PROJECT}/align`, { expectedRevision: 1, segments: [{ start: 0, end: 1, text: 'x', command: 'evil' }] }],
    [`${PROJECT}/align`, { expectedRevision: 1, segments: [{ start: 2, end: 1, text: 'x' }] }],
    [`${PROJECT}/render`, { expectedRevision: 1, preview: 'yes' }],
    [`${PROJECT}/render`, { expectedRevision: 1, shell: 'evil' }],
    [`${PROJECT}/restore`, { expectedRevision: 1, revision: -1 }],
    [`${PROJECT}/narration`, { expectedRevision: 1, text: 'x', voiceProfile: 'untrusted' }],
    [`${PROJECT}/agent`, { expectedRevision: 1, prompt: 'go', preset: 'unrestricted' }],
    [`${PROJECT}/agent`, { expectedRevision: 1, prompt: '' }],
    [`${PROJECT}/render`, { expectedRevision: '1' }],
    [`${PROJECT}/render`, {}],
    [`${BASE}/api/jobs/job1/cancel`, { projectId: 'other' }],
  ]
  for (const [path, body] of invalid) denied(await request(path, { method: 'POST', body }), 400)
  denied(await request(PROJECT, { method: 'PATCH', body: { expectedRevision: 1, patch: { style: { command: 'evil' } } } }), 400)
  for (const raw of ['{"__proto__":{"polluted":true}}', '{"credits":{"constructor":{"prototype":{"polluted":true}}}}']) denied(await request(`${BASE}/api/projects`, { method: 'POST', raw, headers: { 'content-type': 'application/json' } }), 400, 'UNKNOWN_FIELD')
  assert.equal({}.polluted, undefined)
  assert.equal(calls.length, 0)
})

const uploadHeaders = { 'content-type': 'audio/wav', 'x-file-name': encodeURIComponent('完整录音.wav'), 'x-asset-kind': 'audio', 'x-project-revision': '2' }
test('binary upload decodes filename and passes only bounded bytes/name/kind; Core determines MIME', async t => {
  const { request, calls } = await fixture(t)
  const result = ok(await request(`${PROJECT}/assets`, { method: 'POST', raw: 'synthetic bytes', headers: uploadHeaders }))
  assert.equal(result.asset.mime, 'audio/wav')
  const call = calls.at(-1)
  assert.equal(call.projectId, 'story'); assert.equal(call.expectedRevision, 2)
  assert.deepEqual(call.input, { name: '完整录音.wav', kind: 'audio', buffer: Buffer.from('synthetic bytes') })
  // A misleading extension is not trusted as a MIME detector or media probe.
  ok(await request(`${PROJECT}/assets`, { method: 'POST', raw: 'not inspected by HTTP', headers: { ...uploadHeaders, 'x-file-name': 'misleading.mp3', 'content-type': 'application/octet-stream' } }))
  assert.equal(calls.at(-1).input.mime, undefined)
})

test('uploads enforce declared/cumulative limits, safe filenames, headers, empty bodies and content types', async t => {
  const { request, calls } = await fixture(t)
  denied(await request(`${PROJECT}/assets`, { method: 'POST', raw: 'x', headers: { ...uploadHeaders, 'content-length': '33' } }), 413, 'ASSET_TOO_LARGE')
  denied(await request(`${PROJECT}/assets`, { method: 'POST', chunks: [Buffer.alloc(20), Buffer.alloc(20)], headers: uploadHeaders }), 413, 'ASSET_TOO_LARGE')
  denied(await request(`${PROJECT}/assets`, { method: 'POST', raw: '', headers: uploadHeaders }), 413, 'ASSET_TOO_LARGE')
  for (const name of ['../movie.wav', 'nested/movie.wav', 'nested\\movie.wav', 'C:\\private\\movie.wav', '\u0000bad.wav', '..', 'a'.repeat(241), 'evil%2f.wav']) {
    denied(await request(`${PROJECT}/assets`, { method: 'POST', raw: 'x', headers: { ...uploadHeaders, 'x-file-name': encodeURIComponent(name) } }), 400, 'INVALID_FILE_NAME')
  }
  denied(await request(`${PROJECT}/assets`, { method: 'POST', raw: 'x', headers: { ...uploadHeaders, 'x-file-name': '%QZ' } }), 400)
  for (const value of ['', '0', '-1', '1.5', '1e2', '9007199254740992']) denied(await request(`${PROJECT}/assets`, { method: 'POST', raw: 'x', headers: { ...uploadHeaders, 'x-project-revision': value } }), 400)
  for (const type of ['text/plain', 'text/html', 'image/svg+xml', 'application/x-msdownload', 'application/json']) denied(await request(`${PROJECT}/assets`, { method: 'POST', raw: 'x', headers: { ...uploadHeaders, 'content-type': type } }), 415)
  denied(await request(`${PROJECT}/assets`, { method: 'POST', raw: 'x', headers: { ...uploadHeaders, 'x-asset-kind': 'video' } }), 400)
  assert.equal(calls.length, 0)
})

test('upload default is 100 MiB and rejects oversized declaration without buffering bytes', async t => {
  const { request, calls } = await fixture(t, { config: {} })
  denied(await request(`${PROJECT}/assets`, { method: 'POST', raw: 'x', headers: { ...uploadHeaders, 'content-length': String(100 * 1024 * 1024 + 1) } }), 413, 'ASSET_TOO_LARGE')
  assert.equal(calls.length, 0)
})

test('upload reservations cover body reads and Core work: two per Core, one per project', async t => {
  const { request, core } = await fixture(t)
  const entered = new Map(), gates = new Map()
  for (const id of ['story', 'second']) {
    let arrive, release
    entered.set(id, { promise: new Promise(resolve => { arrive = resolve }), arrive: () => arrive() })
    gates.set(id, { promise: new Promise(resolve => { release = resolve }), release: () => release() })
  }
  const normal = core.importAsset.bind(core)
  core.importAsset = async (...args) => {
    entered.get(args[0])?.arrive()
    await gates.get(args[0])?.promise
    return normal(...args)
  }
  t.after(() => { for (const gate of gates.values()) gate.release() })
  const first = request(`${PROJECT}/assets`, { method: 'POST', raw: 'a', headers: uploadHeaders })
  await entered.get('story').promise
  denied(await request(`${PROJECT}/assets`, { method: 'POST', raw: 'b', headers: uploadHeaders }), 429, 'UPLOAD_BUSY')
  // Explicit chunks make the second upload's Content-Length unknown.
  const second = request(`${BASE}/api/projects/second/assets`, { method: 'POST', chunks: ['b'], headers: uploadHeaders })
  await entered.get('second').promise
  const rejected = await request(`${BASE}/api/projects/third/assets`, { method: 'POST', raw: 'c', headers: uploadHeaders })
  denied(rejected, 429, 'UPLOAD_BUSY')
  assert.equal(rejected.headers.connection, 'close')
  ok(await request(PROJECT)) // Unrelated requests remain usable while saturated.
  const independent = await fixture(t)
  ok(await independent.request(`${PROJECT}/assets`, { method: 'POST', raw: 'x', headers: uploadHeaders }))
  gates.get('story').release(); ok(await first)
  ok(await request(`${BASE}/api/projects/third/assets`, { method: 'POST', raw: 'c', headers: uploadHeaders }))
  gates.get('second').release(); ok(await second)
  ok(await request(`${PROJECT}/assets`, { method: 'POST', raw: 'a', headers: uploadHeaders }))
})

test('partial unknown-length body reserves before import and abort releases its project slot', async t => {
  const { request, calls, port, server } = await fixture(t)
  let incoming
  const arrival = new Promise(resolve => server.once('request', req => { incoming = req; resolve() }))
  const partial = http.request({ hostname: '127.0.0.1', port, path: `${PROJECT}/assets`, method: 'POST', headers: uploadHeaders })
  partial.on('error', () => {})
  t.after(() => partial.destroy())
  partial.write('a')
  await arrival
  assert.equal(calls.length, 0) // No complete body or Core import yet.
  denied(await request(`${PROJECT}/assets`, { method: 'POST', raw: 'b', headers: uploadHeaders }), 429, 'UPLOAD_BUSY')
  const aborted = new Promise(resolve => incoming.once('aborted', resolve))
  partial.destroy(); await aborted
  ok(await request(`${PROJECT}/assets`, { method: 'POST', raw: 'c', headers: uploadHeaders }))
  assert.equal(calls.filter(c => c.operation === 'importAsset').length, 1)
})

test('upload reservation releases after body-limit and Core errors, without allocating large media', async t => {
  const { request, core } = await fixture(t)
  const normal = core.importAsset.bind(core)
  for (const options of [
    { raw: '', headers: uploadHeaders },
    { raw: 'x', headers: { ...uploadHeaders, 'content-length': '33' } },
    { chunks: [Buffer.alloc(20), Buffer.alloc(20)], headers: uploadHeaders },
  ]) {
    denied(await request(`${PROJECT}/assets`, { method: 'POST', ...options }), 413)
    ok(await request(`${PROJECT}/assets`, { method: 'POST', raw: 'a', headers: uploadHeaders }))
  }
  for (const error of [new Error('internal failure'), new ProjectError('REVISION_CONFLICT', 'Refresh and retry.', 409)]) {
    core.importAsset = async () => { throw error }
    denied(await request(`${PROJECT}/assets`, { method: 'POST', raw: 'a', headers: uploadHeaders }), error instanceof ProjectError ? 409 : 500)
    core.importAsset = normal
    ok(await request(`${PROJECT}/assets`, { method: 'POST', raw: 'b', headers: uploadHeaders }))
  }
})

test('HTTP pause target range matches Core: inclusive 0.25 through 3 seconds', async t => {
  const { request, calls } = await fixture(t)
  const operation = { type: 'shorten_pause', afterDialogueId: 'before', beforeDialogueId: 'after' }
  for (const targetSeconds of [0, .249, 3.001, 600, '1']) {
    denied(await request(`${PROJECT}/edits`, { method: 'POST', body: { expectedRevision: 1, operation: { ...operation, targetSeconds } } }), 400, 'INVALID_OPERATION')
  }
  assert.equal(calls.length, 0)
  for (const targetSeconds of [.25, 3]) ok(await request(`${PROJECT}/edits`, { method: 'POST', body: { expectedRevision: 1, operation: { ...operation, targetSeconds } } }))
})

test('media GET and HEAD stream actual bytes without exposing internal paths or caching private media', async t => {
  const { request, calls, media } = await fixture(t)
  const result = await request(`${PROJECT}/assets/movie`)
  assert.equal(result.status, 200); assert.equal(result.text, '0123456789')
  assert.equal(result.headers['content-type'], 'video/mp4')
  assert.equal(result.headers['content-length'], '10')
  assert.equal(result.headers['accept-ranges'], 'bytes')
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.ok(!JSON.stringify(result.headers).includes(media))
  const head = await request(`${PROJECT}/assets/movie`, { method: 'HEAD', headers: { range: 'bytes=1-2' } })
  assert.equal(head.status, 200); assert.equal(head.text, ''); assert.equal(head.headers['content-length'], '10')
  assert.deepEqual(calls.at(-1), { operation: 'asset', projectId: 'story', assetId: 'movie' })
})

test('media supports closed/open/suffix ranges, clamps ends and rejects multi/invalid/unsatisfiable ranges', async t => {
  const { request } = await fixture(t)
  for (const [range, text, contentRange] of [
    ['bytes=2-5', '2345', 'bytes 2-5/10'], ['bytes=7-', '789', 'bytes 7-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=-100', '0123456789', 'bytes 0-9/10'],
    ['bytes=9-100', '9', 'bytes 9-9/10'], ['bytes=0-0', '0', 'bytes 0-0/10'],
  ]) {
    const result = await request(`${PROJECT}/assets/movie`, { headers: { range } })
    assert.equal(result.status, 206); assert.equal(result.text, text)
    assert.equal(result.headers['content-range'], contentRange)
    assert.equal(Number(result.headers['content-length']), text.length)
  }
  for (const range of ['bytes=10-', 'bytes=5-1', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4', 'items=0-1', 'bytes=9007199254740992-', 'bytes=0-9007199254740992']) {
    const result = await request(`${PROJECT}/assets/movie`, { headers: { range } })
    denied(result, 416, 'RANGE_NOT_SATISFIABLE'); assert.equal(result.headers['content-range'], 'bytes */10')
  }
  const ifRange = await request(`${PROJECT}/assets/movie`, { headers: { range: 'bytes=0-1', 'if-range': '"unknown"' } })
  assert.equal(ifRange.status, 200); assert.equal(ifRange.text, '0123456789')
})

test('asset ownership and MIME stay Core-controlled; unknown errors/DTO internals cannot expose file paths or credentials', async t => {
  const { request, core, media } = await fixture(t)
  core.asset = async () => { throw new ProjectError('ASSET_NOT_FOUND', 'Asset not found.', 404) }
  denied(await request(`${PROJECT}/assets/other`), 404, 'ASSET_NOT_FOUND')
  core.asset = async () => ({ path: media, mime: 'text/html', bytes: 10 })
  denied(await request(`${PROJECT}/assets/html`), 500, 'INTERNAL_ERROR')
  core.asset = async () => ({ path: media, mime: 'video/mp4', bytes: 999 })
  denied(await request(`${PROJECT}/assets/movie`), 500)
  for (const error of [new Error(`private ${media} token=do-not-expose`), new ProjectError('WORKER_FAILED', `Could not open ${media}`), new ProjectError('WORKER_FAILED', 'Cannot open /srv/private-assets/movie.mp4'), Object.assign(new Error('secret'), { code: 'INVALID_TEXT', status: 400 })]) {
    core.health = async () => { throw error }
    const result = await request(`${BASE}/api/health`)
    assert.ok(result.status >= 400)
    assert.ok(!result.text.includes(media)); assert.ok(!result.text.includes('do-not-expose')); assert.ok(!result.text.includes('stack'))
    if (!(error instanceof ProjectError)) assert.equal(result.envelope.error.code, 'INTERNAL_ERROR')
  }
  core.health = async () => { throw new ProjectError('REVISION_CONFLICT', 'Project changed; refresh and retry.', 409) }
  const conflict = await request(`${BASE}/api/health`)
  denied(conflict, 409, 'REVISION_CONFLICT'); assert.equal(conflict.envelope.error.message, 'Project changed; refresh and retry.')
  core.dispatch = async () => ({ id: 'story', path: media, config: { token: 'do-not-expose' }, assets: [{ id: 'a', filePath: media }], nested: { azureKey: 'do-not-expose' } })
  const dto = ok(await request(PROJECT))
  assert.deepEqual(dto, { id: 'story', assets: [{ id: 'a' }], nested: {} })
})
