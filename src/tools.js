import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

export const inject = ['tools', 'paperDirector']
// This field is administrator-owned composition data, never a model parameter.
export const Config = Schema.object({ projectId: Schema.string().default('') })
const idPattern = /^[A-Za-z0-9_-]{1,64}$/
const revision = { type: 'integer', required: true, description: 'Exact project revision last read; stale writes are rejected.' }
const text = (description, required = true) => ({ type: 'string', description, ...(required ? { required: true } : {}) })
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }
const pause = {
  expectedRevision: revision,
  afterDialogueId: text('Dialogue immediately before the pause.'),
  beforeDialogueId: text('Dialogue immediately after the pause.'),
  targetSeconds: { type: 'number', required: true, description: 'Remaining pause duration in seconds, from 0.25 to 3.' },
}

function pauseArgs(args) {
  if (!Number.isFinite(args.targetSeconds) || args.targetSeconds < 0.25 || args.targetSeconds > 3) throw new Error('Invalid target pause length')
  for (const key of ['afterDialogueId', 'beforeDialogueId']) if (!idPattern.test(args[key])) throw new Error('Invalid dialogue identity')
  return { expectedRevision: args.expectedRevision, operation: { type: 'shorten_pause', afterDialogueId: args.afterDialogueId, beforeDialogueId: args.beforeDialogueId, targetSeconds: args.targetSeconds } }
}
function storyArgs(args) {
  if (typeof args.patchJson !== 'string' || args.patchJson.length > 64000) throw new Error('Story patch exceeds the tool limit')
  const patch = JSON.parse(args.patchJson)
  if (!patch || Array.isArray(patch) || typeof patch !== 'object') throw new Error('Story patch must be an object')
  const allowed = new Set(['title', 'story', 'credits', 'characters', 'scenes', 'style'])
  for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new Error('Story patch contains a protected field')
  // No transport escape hatch hidden inside JSON. Core still validates the full domain schema.
  const check = (value) => {
    if (!value || typeof value !== 'object') return
    for (const key of Object.keys(value)) {
      if (['__proto__', 'constructor', 'prototype', 'allowUnmatchedSpeech', 'projectId', 'path', 'inputPath', 'outputDir', 'azureKeyEnv'].includes(key)) throw new Error('Story patch contains a forbidden field')
      check(value[key])
    }
  }
  check(patch)
  return { expectedRevision: args.expectedRevision, patch }
}

/** Mount ONLY in the dedicated Agent preset, not in the Host bundle. */
export function apply(ctx, config = {}) {
  if (config.projectId && !idPattern.test(config.projectId)) throw new Error('Invalid administrator-bound project identity')
  ctx.tools.restrict({ allow: [] })
  const register = (name, description, parameters, operation, normalize = (args) => args) => {
    ctx.tools.register(defineTool({
      name, description, parameters, output,
      async execute(args, exec) {
        // DSH's parameter shorthand may accept additional properties. Refuse them
        // explicitly instead of relying on model-facing schema validation.
        for (const key of Object.keys(args)) if (!Object.hasOwn(parameters, key)) throw new Error('Unknown media tool argument')
        const sessionId = exec.agent?.session?.id
        if (!sessionId) throw new Error('Paper Director requires a session-bound caller')
        const projectId = config.projectId || await ctx.paperDirector.bindingForSession(String(sessionId))
        if (typeof projectId !== 'string' || !idPattern.test(projectId)) throw new Error('No trusted project binding; open this project from the studio first')
        if (args.expectedRevision !== undefined && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0)) throw new Error('Invalid expected revision')
        const op = typeof operation === 'function' ? operation(args) : operation
        const scope = config.projectId ? { projectId } : { projectId, sessionId: String(sessionId) }
        const result = await ctx.paperDirector.dispatch(op, normalize(args), scope)
        return JSON.stringify(result)
      },
    }))
  }
  register('paper_project', 'Read only the current bound project, including its revision and readiness warnings.', {}, 'project.get', () => ({}))
  register('paper_update_story', 'Apply an explicitly requested storyboard edit. Preserve child-authored dialogue; do not replace it with ASR observations. Only title/story/credits/characters/scenes/style can be patched.', { expectedRevision: revision, patchJson: text('JSON object containing only the requested storyboard changes.') }, 'project.update', storyArgs)
  register('paper_align', 'Start configured local alignment of the ONE complete recording. Never invent recognized speech or upload recordings.', { expectedRevision: revision }, 'recording.align', (args) => ({ expectedRevision: args.expectedRevision }))
  register('paper_render', 'Render an immutable revision. A queued job is not a completed or reviewed movie.', { expectedRevision: revision, preview: { type: 'boolean', description: 'Render a smaller preview using the same timeline.' } }, 'movie.render', (args) => ({ expectedRevision: args.expectedRevision, preview: args.preview === true }))
  register('paper_locate', 'Locate feedback in the actual viewed export, not the current source recording. Supply the movie asset and playback time; stale export revisions are identified explicitly.', { assetId: text('The exact viewed movie asset identity.'), time: { type: 'number', required: true, description: 'Playback time in seconds in that movie.' } }, 'movie.locate', (args) => {
    if ((typeof args.assetId !== 'string' || !idPattern.test(args.assetId)) || !Number.isFinite(args.time) || args.time < 0) throw new Error('Invalid movie location')
    return { assetId: args.assetId, time: args.time }
  })
  register('paper_jobs', 'List, inspect or cancel media jobs belonging only to this project.', { action: { type: 'string', enum: ['list', 'get', 'cancel'], required: true }, jobId: text('Required for get/cancel; a job from this project.', false) }, (args) => {
    if (!['list', 'get', 'cancel'].includes(args.action)) throw new Error('Invalid job action')
    return `job.${args.action}`
  }, (args) => {
    if (args.action === 'list') return {}
    if (!idPattern.test(args.jobId)) throw new Error('A valid job identity is required')
    return { jobId: args.jobId }
  })
  register('paper_pause_propose', 'Propose shortening a pause between known dialogue. Show protected or unmatched speech warnings; this does not apply an edit.', pause, 'timeline.propose', pauseArgs)
  register('paper_pause_apply', 'Apply the pause change explicitly requested by the human. Never delete unmatched speech; protected ranges remain blocked.', pause, 'timeline.apply', (args) => ({ ...pauseArgs(args), allowUnmatchedSpeech: false }))
  register('paper_narration', 'Generate adult-enabled Azure narration from approved text ONLY. Cloud narration is disabled by default; never send recordings.', { expectedRevision: revision, text: text('Exact text approved by the author for the narrator.') }, 'narration.generate', (args) => {
    if (!args.text.trim() || args.text.length > 500) throw new Error('Narration text must contain 1–500 characters')
    return { expectedRevision: args.expectedRevision, text: args.text, voiceProfile: 'narrator' }
  })
}
