import { open, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { ProjectError } from './core/model.js'

const ROOT = '/paper-director'
const JSON_LIMIT = 1024 * 1024
const DEFAULT_ASSET_LIMIT = 100 * 1024 * 1024
// Shared across requests to one Core, without retaining stopped Core instances.
const UPLOAD_BUDGETS = new WeakMap()
function reserveUpload(core, projectId, limit) {
  let budget = UPLOAD_BUDGETS.get(core)
  if (!budget) { budget = { projects: new Set(), bytes: 0 }; UPLOAD_BUDGETS.set(core, budget) }
  // Conservatively reserve the entire allowed body even for a smaller declared
  // length. Chunked/unknown lengths can never overcommit the byte budget.
  if (budget.projects.size >= 2 || budget.projects.has(projectId) || budget.bytes + limit > 2 * limit) reject('UPLOAD_BUSY', 'Another upload is in progress. Please retry shortly.', 429)
  budget.projects.add(projectId); budget.bytes += limit
  return () => {
    budget.projects.delete(projectId); budget.bytes -= limit
    if (!budget.projects.size) UPLOAD_BUDGETS.delete(core)
  }
}
const ID = /^[A-Za-z0-9_-]{1,64}$/
const AUTHOR_FIELDS = ['title', 'story', 'credits', 'characters', 'scenes', 'recordingAssetId', 'style']
const STATIC = new Map([
  [`${ROOT}/`, ['index.html', 'text/html; charset=utf-8']],
  [`${ROOT}/static/studio.js`, ['studio.js', 'text/javascript; charset=utf-8']],
  [`${ROOT}/static/studio.css`, ['studio.css', 'text/css; charset=utf-8']],
])
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const AUDIO_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/webm', 'audio/ogg', 'application/ogg', 'audio/flac', 'audio/x-flac', 'audio/aac', 'video/mp4', 'video/webm'])
const MEDIA_TYPES = new Set([...IMAGE_TYPES, ...AUDIO_TYPES])
const PRIVATE_KEYS = /^(?:path|filePath|inputPath|outputPath|outputDir|dataDir|fontPath|modelPath|asrModelPath|pythonPath|config|credentials|authorization|cookie|apiKey|azureKey|token|secret|stack)$/i
const PRIVATE_TEXT = /(?:[A-Za-z]:[\\/]|\\\\|\/(?:home|Users|tmp|var|etc|root|private|opt|mnt)\/|(?:api[_-]?key|authorization|password|secret|token)\s*[:=]|\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+)/i
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'SAMEORIGIN',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'self'",
}

function reject(code, message, status = 400) { throw new ProjectError(code, message, status) }
function record(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('INVALID_OBJECT', 'A JSON object is required.')
  for (const key of Object.keys(value)) if (!fields.includes(key)) reject('UNKNOWN_FIELD', 'Unknown request field.')
  return value
}
function identifier(value) {
  if (typeof value !== 'string' || !ID.test(value)) reject('INVALID_ID', 'Invalid identity.')
  return value
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) reject('EXPECTED_REVISION_REQUIRED', 'A positive project revision is required.')
  return value
}
function boundedText(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || (required && !value.trim())) reject('INVALID_TEXT', 'Invalid text.')
}
function bool(value) { if (typeof value !== 'boolean') reject('INVALID_BOOLEAN', 'A boolean is required.') }
function boundedArray(value, max) {
  if (!Array.isArray(value) || value.length > max) reject('INVALID_ARRAY', 'Invalid request list.')
}
function author(input) {
  record(input, AUTHOR_FIELDS)
  for (const [key, max] of [['title', 120], ['story', 8000]]) if (key in input) boundedText(input[key], max)
  if ('credits' in input) {
    record(input.credits, ['director', 'voice'])
    for (const value of Object.values(input.credits)) boundedText(value, 80)
  }
  if ('characters' in input) {
    boundedArray(input.characters, 8)
    for (const c of input.characters) {
      record(c, ['id', 'name', 'color'])
      if ('id' in c) identifier(c.id)
      if ('name' in c) boundedText(c.name, 40)
      if ('color' in c && (typeof c.color !== 'string' || !/^#[a-f0-9]{6}$/i.test(c.color))) reject('INVALID_COLOR', 'Invalid character color.')
    }
  }
  if ('scenes' in input) {
    boundedArray(input.scenes, 100)
    for (const scene of input.scenes) {
      record(scene, ['id', 'imageAssetId', 'action', 'dialogue', 'transition', 'timeLabel'])
      if ('id' in scene) identifier(scene.id)
      if (scene.imageAssetId != null) identifier(scene.imageAssetId)
      if ('action' in scene) boundedText(scene.action, 4000)
      if ('timeLabel' in scene) boundedText(scene.timeLabel, 120)
      if ('transition' in scene && !['cut', 'magic', 'time'].includes(scene.transition)) reject('INVALID_TRANSITION', 'Invalid transition.')
      if ('dialogue' in scene) {
        boundedArray(scene.dialogue, 30)
        for (const d of scene.dialogue) {
          record(d, ['id', 'characterId', 'text', 'mode'])
          if ('id' in d) identifier(d.id)
          identifier(d.characterId)
          if ('text' in d) boundedText(d.text, 1000)
          if ('mode' in d && !['normal', 'thought', 'small', 'burst'].includes(d.mode)) reject('INVALID_DIALOGUE_MODE', 'Invalid dialogue mode.')
        }
      }
    }
  }
  if (input.recordingAssetId != null) identifier(input.recordingAssetId)
  if ('style' in input) {
    record(input.style, ['width', 'height', 'fps', 'introSeconds', 'outroSeconds', 'comic', 'soundEffects', 'narrationAssetId', 'narrationText', 'travelSoundAssetId', 'timeSoundAssetId'])
    // Numeric/style semantics and project-owned asset references are checked by Core.
    for (const key of ['narrationAssetId', 'travelSoundAssetId', 'timeSoundAssetId']) if (input.style[key] != null) identifier(input.style[key])
  }
  return input
}
function header(req, name) {
  const value = req.headers[name]
  if (Array.isArray(value)) reject('INVALID_HEADER', 'Invalid request header.')
  return value
}
function requestTarget(req) {
  const target = req.url
  // Inspect the raw target BEFORE URL parsing can normalize dot segments or backslashes.
  if (typeof target !== 'string' || target.length > 4096 || !target.startsWith('/') || /[\\#\u0000-\u0020\u007f]/.test(target)) reject('INVALID_PATH', 'Invalid request path.')
  const [path, query = ''] = target.split('?')
  if (target.split('?').length > 2 || /%|\/\/|(?:^|\/)\.{1,2}(?:\/|$)/.test(path)) reject('INVALID_PATH', 'Invalid request path.')
  if (/%(?![0-9a-f]{2})/i.test(query)) reject('INVALID_QUERY', 'Invalid query.')
  return { path, query: new URLSearchParams(query) }
}
function queryFields(query, allowed = []) {
  const seen = new Set()
  for (const [key] of query) {
    if (!allowed.includes(key) || seen.has(key)) reject('INVALID_QUERY', 'Unknown or repeated query parameter.')
    seen.add(key)
  }
}
function sameOrigin(req) {
  // Defense in depth only: authentication AND the authoritative Host fence belong
  // to index.authenticatedHandler -> connection.requestRejection, on EVERY path.
  const host = header(req, 'host')
  if (typeof host !== 'string' || !host || /[\s/@\\?#]/.test(host)) reject('FORBIDDEN', 'Request rejected.', 403)
  let authority
  try { authority = new URL(`http://${host}`); if (authority.host !== host.toLowerCase()) throw new Error() }
  catch { reject('FORBIDDEN', 'Request rejected.', 403) }
  const origin = header(req, 'origin')
  if (origin !== undefined) {
    try {
      const parsed = new URL(origin)
      const protocol = req.socket?.encrypted ? 'https:' : 'http:'
      if (parsed.protocol !== protocol || parsed.host !== authority.host || parsed.origin !== origin || parsed.username || parsed.password) throw new Error()
    } catch { reject('FORBIDDEN', 'Request rejected.', 403) }
  }
  if (['cross-site', 'same-site'].includes(header(req, 'sec-fetch-site'))) reject('FORBIDDEN', 'Request rejected.', 403)
}
function method(req, res, allowed) {
  if (!allowed.includes(req.method)) {
    res.setHeader('allow', allowed.join(', '))
    reject('METHOD_NOT_ALLOWED', 'Method not allowed.', 405)
  }
}
function noBody(req) {
  if (header(req, 'transfer-encoding') !== undefined || (header(req, 'content-length') !== undefined && header(req, 'content-length') !== '0')) reject('UNEXPECTED_BODY', 'This request does not accept a body.')
}
function contentType(req, json = false) {
  const value = header(req, 'content-type') || ''
  if (json) {
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(value)) reject('UNSUPPORTED_CONTENT_TYPE', 'Use application/json.', 415)
  }
  const encoding = header(req, 'content-encoding')
  if (encoding !== undefined && encoding.toLowerCase() !== 'identity') reject('UNSUPPORTED_CONTENT_ENCODING', 'Compressed request bodies are not supported.', 415)
  return value.split(';')[0].trim().toLowerCase()
}
async function bodyBytes(req, limit, code) {
  const length = header(req, 'content-length')
  if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) reject('INVALID_CONTENT_LENGTH', 'Invalid content length.')
  if (length !== undefined && Number(length) > limit) reject(code, 'Request body is too large.', 413)
  if (req.readableEnded) return Buffer.alloc(0)
  return new Promise((resolve, rejectPromise) => {
    let total = 0
    const chunks = []
    const cleanup = () => {
      clearTimeout(timer)
      req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted)
    }
    const failBody = error => {
      cleanup(); chunks.length = 0
      // IncomingMessage may emit ECONNRESET after 'aborted'. Keep that late
      // transport error from becoming an unhandled event after cleanup.
      req.once('error', () => {})
      rejectPromise(error)
    }
    const data = chunk => {
      total += chunk.length
      // Check before retaining chunks, and never concatenate an oversized body.
      if (total > limit) { failBody(new ProjectError(code, 'Request body is too large.', 413)); req.resume(); return }
      chunks.push(chunk)
    }
    const end = () => {
      cleanup()
      if (length !== undefined && Number(length) !== total) { rejectPromise(new ProjectError('INVALID_CONTENT_LENGTH', 'Body length does not match.')); return }
      resolve(Buffer.concat(chunks, total))
    }
    const error = () => failBody(new ProjectError('INVALID_BODY', 'Request body could not be read.'))
    const aborted = () => failBody(new ProjectError('INVALID_BODY', 'Request body was interrupted.'))
    const timer = setTimeout(() => { failBody(new ProjectError('REQUEST_TIMEOUT', 'Request body timed out.', 408)); req.resume() }, 30000)
    timer.unref()
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted)
  })
}
async function jsonBody(req, fields) {
  contentType(req, true)
  const buffer = await bodyBytes(req, JSON_LIMIT, 'BODY_TOO_LARGE')
  let value
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) }
  catch { reject('INVALID_JSON', 'Invalid JSON body.') }
  return record(value, fields)
}
function json(req, res, status, value) {
  // Core returns owned, sanitized DTOs; this is an extra guard against accidental
  // internal path/config additions. Never serialize core.asset() itself.
  const payload = Buffer.from(JSON.stringify(value, (key, item) => PRIVATE_KEYS.test(key) ? undefined : item))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length })
  res.end(req.method === 'HEAD' ? undefined : payload)
}
async function staticFile(req, res, entry) {
  const [name, mime] = entry
  const data = await readFile(new URL(`../web/${name}`, import.meta.url))
  const etag = `"${createHash('sha256').update(data).digest('hex')}"`
  res.setHeader('cache-control', 'private, no-cache, must-revalidate')
  res.setHeader('etag', etag)
  res.setHeader('content-type', mime)
  if ((header(req, 'if-none-match') || '').split(',').some(item => ['*', etag, `W/${etag}`].includes(item.trim()))) { res.writeHead(304); res.end(); return }
  res.writeHead(200, { 'content-length': data.length })
  res.end(req.method === 'HEAD' ? undefined : data)
}
function rangeBounds(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (!match || (!match[1] && !match[2]) || !size) return null
  const a = match[1] ? Number(match[1]) : undefined
  const b = match[2] ? Number(match[2]) : undefined
  if ((a !== undefined && !Number.isSafeInteger(a)) || (b !== undefined && !Number.isSafeInteger(b))) return null
  if (a === undefined) return b > 0 ? [Math.max(0, size - b), size - 1] : null
  if (a >= size || (b !== undefined && b < a)) return null
  return [a, Math.min(b ?? size - 1, size - 1)]
}
async function assetFile(core, req, res, projectId, assetId) {
  const asset = await core.asset(projectId, assetId)
  if (!asset || typeof asset.path !== 'string' || !MEDIA_TYPES.has(asset.mime) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0) throw new Error('Invalid internal asset')
  const file = await open(asset.path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size !== asset.bytes) throw new Error('Invalid internal asset size')
    res.setHeader('accept-ranges', 'bytes')
    res.setHeader('content-type', asset.mime)
    let status = 200, bounds
    const range = header(req, 'range')
    // No media validators under no-store: an If-Range condition cannot match.
    // RFC Range only modifies GET, not HEAD.
    if (req.method === 'GET' && range !== undefined && header(req, 'if-range') === undefined) {
      bounds = rangeBounds(range, stat.size)
      if (!bounds) {
        res.setHeader('content-range', `bytes */${stat.size}`)
        reject('RANGE_NOT_SATISFIABLE', 'Requested byte range is not available.', 416)
      }
      status = 206
      res.setHeader('content-range', `bytes ${bounds[0]}-${bounds[1]}/${stat.size}`)
    }
    res.writeHead(status, { 'content-length': bounds ? bounds[1] - bounds[0] + 1 : stat.size })
    if (req.method === 'HEAD' || !stat.size) { res.end(); return }
    const stream = file.createReadStream({ autoClose: false, ...(bounds ? { start: bounds[0], end: bounds[1] } : {}) })
    await new Promise((resolve, rejectPromise) => {
      const cleanup = () => { res.off('close', closed); res.off('finish', finished); stream.off('error', failed) }
      const closed = () => { cleanup(); stream.destroy(); resolve() }
      const finished = () => { cleanup(); resolve() }
      const failed = error => { cleanup(); stream.destroy(); rejectPromise(error) }
      res.once('close', closed); res.once('finish', finished); stream.once('error', failed)
      stream.pipe(res)
    })
  } finally { await file.close() }
}
async function upload(core, req, projectId) {
  const mime = contentType(req)
  const kind = header(req, 'x-asset-kind')
  if (!['image', 'audio'].includes(kind)) reject('INVALID_ASSET_KIND', 'Choose image or audio.')
  if (!(kind === 'image' ? IMAGE_TYPES : AUDIO_TYPES).has(mime) && mime !== 'application/octet-stream') reject('UNSUPPORTED_CONTENT_TYPE', 'Unsupported upload content type.', 415)
  const rawName = header(req, 'x-file-name')
  let name
  try { if (typeof rawName !== 'string' || rawName.length > 2400) throw new Error(); name = decodeURIComponent(rawName) }
  catch { reject('INVALID_FILE_NAME', 'Invalid upload filename.') }
  if (!name || name.length > 240 || /[\\/:%\u0000-\u001f\u007f]/.test(name) || name === '.' || name === '..') reject('INVALID_FILE_NAME', 'Use a filename without a local path.')
  const rev = header(req, 'x-project-revision')
  if (typeof rev !== 'string' || !/^[1-9]\d*$/.test(rev)) reject('EXPECTED_REVISION_REQUIRED', 'A project revision is required.')
  const expectedRevision = revision(Number(rev))
  const configured = core.config?.maxAssetBytes
  const limit = Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_ASSET_LIMIT
  const release = reserveUpload(core, projectId, limit)
  try {
    const buffer = await bodyBytes(req, limit, 'ASSET_TOO_LARGE')
    if (!buffer.length) reject('ASSET_TOO_LARGE', 'The upload is empty.', 413)
    // Await inside the try: keep the reservation while Core retains the buffer
    // for its media probe and persistence, including after client disconnect.
    return await core.importAsset(projectId, expectedRevision, { name, kind, buffer })
  } finally { release() }
}

/** Router only. Production callers MUST use index.authenticatedHandler first.
 * No listener, credential fallback, model operation, or alternate auth is installed here. */
export async function handleRequest(core, req, res) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value)
  try {
    sameOrigin(req)
    const { path, query } = requestTarget(req)
    if (path === ROOT) {
      method(req, res, ['GET', 'HEAD']); noBody(req); queryFields(query)
      res.writeHead(308, { location: `${ROOT}/`, 'content-length': '0' }); res.end(); return
    }
    if (STATIC.has(path)) {
      method(req, res, ['GET', 'HEAD']); noBody(req); queryFields(query)
      await staticFile(req, res, STATIC.get(path)); return
    }
    let data
    if (path === `${ROOT}/api/health`) {
      method(req, res, ['GET', 'HEAD']); noBody(req); queryFields(query)
      data = await core.health()
    } else if (path === `${ROOT}/api/projects`) {
      method(req, res, ['GET', 'HEAD', 'POST']); queryFields(query)
      if (req.method === 'POST') data = await core.dispatch('project.create', author(await jsonBody(req, AUTHOR_FIELDS)))
      else { noBody(req); data = await core.dispatch('project.list', {}) }
    } else if (path === `${ROOT}/api/jobs`) {
      method(req, res, ['GET', 'HEAD']); noBody(req); queryFields(query, ['projectId'])
      data = await core.dispatch('job.list', { projectId: identifier(query.get('projectId')) })
    } else {
      const job = new RegExp(`^${ROOT}/api/jobs/([^/]+)(/cancel)?$`).exec(path)
      const project = new RegExp(`^${ROOT}/api/projects/([^/]+)(?:/(history|restore|assets|align|render|narration|edits|agent)(?:/([^/]+))?)?$`).exec(path)
      if (job) {
        const jobId = identifier(job[1]); queryFields(query)
        method(req, res, job[2] ? ['POST'] : ['GET', 'HEAD'])
        if (job[2]) await jsonBody(req, [])
        else noBody(req)
        data = await core.dispatch(job[2] ? 'job.cancel' : 'job.get', { jobId })
      } else if (project) {
        const projectId = identifier(project[1]), action = project[2], assetId = project[3]
        queryFields(query)
        if (assetId && action !== 'assets') reject('NOT_FOUND', 'Route not found.', 404)
        if (!action) {
          method(req, res, ['GET', 'HEAD', 'PATCH'])
          if (req.method === 'PATCH') {
            const body = await jsonBody(req, ['expectedRevision', 'patch'])
            revision(body.expectedRevision); author(body.patch)
            data = await core.dispatch('project.update', { projectId, ...body })
          } else { noBody(req); data = await core.dispatch('project.get', { projectId }) }
        } else if (action === 'history') {
          method(req, res, ['GET', 'HEAD']); noBody(req)
          data = await core.dispatch('project.history', { projectId })
        } else if (action === 'assets') {
          if (assetId) {
            identifier(assetId); method(req, res, ['GET', 'HEAD']); noBody(req)
            await assetFile(core, req, res, projectId, assetId); return
          }
          method(req, res, ['POST']); data = await upload(core, req, projectId)
        } else {
          method(req, res, ['POST'])
          const fields = {
            restore: ['expectedRevision', 'revision'], align: ['expectedRevision', 'engine', 'segments'],
            render: ['expectedRevision', 'preview'], narration: ['expectedRevision', 'text', 'voiceProfile'],
            edits: ['expectedRevision', 'operation', 'apply', 'allowUnmatchedSpeech'], agent: ['expectedRevision', 'prompt'],
          }
          const body = await jsonBody(req, fields[action]); revision(body.expectedRevision)
          let operation
          if (action === 'restore') { revision(body.revision); operation = 'project.restore' }
          if (action === 'align') {
            if ('engine' in body && !['whisper', 'vosk', 'segments'].includes(body.engine)) reject('INVALID_ENGINE', 'Invalid alignment engine.')
            if ('segments' in body) {
              boundedArray(body.segments, 5000)
              for (const s of body.segments) {
                record(s, ['dialogueId', 'sceneId', 'characterId', 'start', 'end', 'text'])
                for (const key of ['dialogueId', 'sceneId', 'characterId']) if (key in s) identifier(s[key])
                boundedText(s.text, 4000)
                if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end <= s.start || s.end > 600) reject('INVALID_SEGMENT', 'Invalid segment timing.')
              }
            }
            operation = 'recording.align'
          }
          if (action === 'render') { if ('preview' in body) bool(body.preview); operation = 'movie.render' }
          if (action === 'narration') {
            boundedText(body.text, 500, true)
            if ('voiceProfile' in body && body.voiceProfile !== 'narrator') reject('INVALID_VOICE', 'Invalid voice profile.')
            operation = 'narration.generate'
          }
          if (action === 'edits') {
            record(body.operation, ['type', 'afterDialogueId', 'beforeDialogueId', 'targetSeconds'])
            if (body.operation.type !== 'shorten_pause') reject('INVALID_OPERATION', 'Invalid edit operation.')
            identifier(body.operation.afterDialogueId); identifier(body.operation.beforeDialogueId)
            if (!Number.isFinite(body.operation.targetSeconds) || body.operation.targetSeconds < .25 || body.operation.targetSeconds > 3) reject('INVALID_OPERATION', 'Invalid target duration.')
            if ('apply' in body) bool(body.apply)
            if ('allowUnmatchedSpeech' in body) bool(body.allowUnmatchedSpeech)
            operation = body.apply === true ? 'timeline.apply' : 'timeline.propose'
            delete body.apply
          }
          if (action === 'agent') {
            boundedText(body.prompt, 16000, true)
            // Intentionally unavailable through core.dispatch / model operations.
            data = await core.startAgent({ projectId, ...body })
          } else data = await core.dispatch(operation, { projectId, ...body })
        }
      } else reject('NOT_FOUND', 'Route not found.', 404)
    }
    json(req, res, 200, { ok: true, data })
  } catch (error) {
    if (res.headersSent) { res.destroy(); return }
    // Close rejected-body connections; never keep unread attacker bytes alive.
    if (!req.readableEnded) { res.setHeader('connection', 'close'); req.resume() }
    const known = error instanceof ProjectError && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
    const status = known ? error.status : 500
    const message = known && typeof error.message === 'string' && error.message.length <= 500 && !/[\\/\u0000-\u001f\u007f]/.test(error.message) && !PRIVATE_TEXT.test(error.message) ? error.message : 'The request could not be completed.'
    json(req, res, status, { ok: false, error: { code: known ? error.code : 'INTERNAL_ERROR', message } })
  }
}
