import { randomUUID } from 'node:crypto'

export class ProjectError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'ProjectError'; this.code = code; this.status = status }
}
export const fail = (code, message, status) => { throw new ProjectError(code, message, status) }
export const clone = value => structuredClone(value)
export function id(value, label = 'id') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) fail('INVALID_ID', `Invalid ${label}`)
  return value
}
export function text(value, max, label, fallback = '') {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail('INVALID_TEXT', `Invalid ${label}`)
  return value.trim()
}
export function finite(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail('INVALID_NUMBER', `Invalid ${label}`)
  return value
}
export function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_OBJECT', `Invalid ${label}`)
  return value
}
function array(value, max, label) {
  if (!Array.isArray(value) || value.length > max) fail('INVALID_ARRAY', `Invalid ${label}`)
  return value
}
function unique(items, label) { const ids = items.map(x => x.id); if (new Set(ids).size !== ids.length) fail('DUPLICATE_ID', `Duplicate ${label}`) }
export const DEFAULT_STYLE = Object.freeze({ width: 1280, height: 960, fps: 25, introSeconds: 3, outroSeconds: 4, comic: true, soundEffects: true, narrationAssetId: null, narrationText: '', travelSoundAssetId: null, timeSoundAssetId: null })
export function normalizeStyle(input = {}, previous = DEFAULT_STYLE) {
  object(input, 'style')
  const known = new Set(Object.keys(DEFAULT_STYLE))
  for (const key of Object.keys(input)) if (!known.has(key)) fail('UNKNOWN_FIELD', `Unknown style field ${key}`)
  const s = { ...DEFAULT_STYLE, ...previous, ...input }
  finite(s.width, 320, 1920, 'width'); finite(s.height, 240, 1920, 'height')
  if (!Number.isInteger(s.width) || !Number.isInteger(s.height) || s.width % 2 || s.height % 2 || s.width * s.height > 3686400) fail('INVALID_SIZE', 'Video dimensions must be bounded even integers')
  if (![24, 25, 30].includes(s.fps)) fail('INVALID_FPS', 'Use 24, 25 or 30 fps')
  finite(s.introSeconds, 0, 10, 'introSeconds'); finite(s.outroSeconds, 0, 15, 'outroSeconds')
  if (typeof s.comic !== 'boolean' || typeof s.soundEffects !== 'boolean') fail('INVALID_STYLE', 'comic and soundEffects must be booleans')
  s.narrationText = text(s.narrationText, 500, 'narrationText')
  for (const key of ['narrationAssetId', 'travelSoundAssetId', 'timeSoundAssetId']) if (s[key] !== null) id(s[key], key)
  return s
}
export function normalizeAuthorPatch(project, input) {
  object(input, 'patch')
  const allowed = new Set(['title', 'story', 'credits', 'characters', 'scenes', 'recordingAssetId', 'style'])
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail('UNKNOWN_FIELD', `Field ${key} is not author-editable`)
  const p = clone(project)
  if ('title' in input) p.title = text(input.title, 120, 'title') || '我的纸上故事'
  if ('story' in input) p.story = text(input.story, 8000, 'story')
  if ('credits' in input) { const c = object(input.credits, 'credits'); p.credits = { director: text(c.director, 80, 'director'), voice: text(c.voice, 80, 'voice') } }
  if ('characters' in input) {
    p.characters = array(input.characters, 8, 'characters').map(c => {
      object(c, 'character'); const color = text(c.color, 7, 'color', '#b34470')
      if (!/^#[0-9a-f]{6}$/i.test(color)) fail('INVALID_COLOR', 'Character color must be a six-digit hex value')
      if (['both','narrator'].includes(c.id)) fail('RESERVED_CHARACTER', 'Reserved identity cannot name a character')
      return { id: id(c.id || randomUUID(), 'character id'), name: text(c.name, 40, 'character name') || '角色', color }
    })
    unique(p.characters, 'character id')
  }
  if ('scenes' in input) {
    p.scenes = array(input.scenes, 100, 'scenes').map(s => {
      object(s, 'scene'); const transition = s.transition || 'cut'
      if (!['cut', 'magic', 'time'].includes(transition)) fail('INVALID_TRANSITION', 'Unknown story transition')
      return { id: id(s.id || randomUUID(), 'scene id'), imageAssetId: s.imageAssetId === null || s.imageAssetId === undefined ? null : id(s.imageAssetId),
        action: text(s.action, 4000, 'scene action'), transition, timeLabel: text(s.timeLabel, 120, 'time label'),
        dialogue: array(s.dialogue || [], 30, 'dialogue').map(d => {
          object(d, 'dialogue'); const mode = d.mode || 'normal'
          if (!['normal', 'thought', 'small', 'burst'].includes(mode)) fail('INVALID_DIALOGUE_MODE', 'Unknown dialogue presentation')
          return { id: id(d.id || randomUUID(), 'dialogue id'), characterId: id(d.characterId, 'speaker'), text: text(d.text, 1000, 'dialogue text'), mode }
        }) }
    })
    const lines=p.scenes.flatMap(s => s.dialogue)
    if(lines.length>2048)fail('TOO_MANY_LINES','A project supports at most 2048 dialogue lines')
    unique(p.scenes, 'scene id'); unique(lines, 'dialogue id')
  }
  if ('recordingAssetId' in input) p.recordingAssetId = input.recordingAssetId === null ? null : id(input.recordingAssetId)
  if ('style' in input) p.style = normalizeStyle(input.style, p.style)
  const cast = new Set(p.characters.map(c => c.id))
  for (const s of p.scenes) for (const d of s.dialogue) if (!cast.has(d.characterId) && !['both', 'narrator'].includes(d.characterId)) fail('UNKNOWN_CHARACTER', 'A dialogue line references an unknown character')
  const assets = new Map(p.assets.map(a => [a.id, a]))
  for (const s of p.scenes) if (s.imageAssetId && assets.get(s.imageAssetId)?.kind !== 'image') fail('UNKNOWN_IMAGE', 'A scene must reference an image in this project')
  if (p.recordingAssetId && assets.get(p.recordingAssetId)?.kind !== 'audio') fail('UNKNOWN_RECORDING', 'Recording must belong to this project')
  for (const key of ['narrationAssetId', 'travelSoundAssetId', 'timeSoundAssetId']) if (p.style[key] && assets.get(p.style[key])?.kind !== 'audio') fail('UNKNOWN_AUDIO', 'Sound must belong to this project')
  // Editing names, colours, action notes, photos or presentation must not force
  // a new recording. Only changed timing identity invalidates existing alignment.
  const timingIdentity = value => JSON.stringify({ recording: value.recordingAssetId, scenes: value.scenes.map(s => [s.id, s.dialogue.map(d => [d.id, d.characterId, d.text])]) })
  if (timingIdentity(p) !== timingIdentity(project)) { p.alignment = null; p.edits = [] }
  return p
}
export function newProject(input = {}) {
  const now = new Date().toISOString()
  const p = { id: randomUUID(), revision: 1, createdAt: now, updatedAt: now, title: '我的纸上故事', story: '', credits: { director: '', voice: '' },
    characters: [{ id: 'hero', name: '小禾', color: '#b34470' }, { id: 'friend', name: '阿星', color: '#287f83' }],
    scenes: [], recordingAssetId: null, assets: [], alignment: null, edits: [], style: { ...DEFAULT_STYLE }, exports: [] }
  return normalizeAuthorPatch(p, input)
}
export function probeMetadata(value = {},{maxDuration=600}={}) {
  object(value, 'metadata'); const result = {}
  for (const key of ['duration', 'sampleRate', 'channels', 'width', 'height', 'audioStreams', 'videoStreams']) if (value[key] !== undefined) result[key] = finite(value[key], 0, key === 'duration' ? maxDuration : key === 'sampleRate' ? 192000 : 100000, key)
  if (result.width && result.height && result.width * result.height > 24000000) fail('IMAGE_TOO_LARGE', 'Image exceeds 24 megapixels')
  if (value.codec !== undefined) result.codec = text(value.codec, 80, 'codec')
  if (value.audioClock==='decoded-samples') result.audioClock='decoded-samples'
  for (const key of ['containerDuration','timestampDuration']) if(value[key]!==undefined) result[key]=finite(value[key],0,maxDuration+.1,key)
  return result
}
