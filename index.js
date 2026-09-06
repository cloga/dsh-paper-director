import { randomUUID } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { foldSurface } from '@deepseek-ai/dsh-session'
import { PaperDirectorCore } from './src/core/service.js'
import { handleRequest } from './src/http.js'

export const Config = Schema.object({
  dataDir: Schema.string().default(''),
  pythonPath: Schema.string().default('python'),
  fontPath: Schema.string().default(''),
  asrModelPath: Schema.string().default(''),
  asrEngine: Schema.union(['whisper', 'vosk', 'segments']).default('whisper'),
  allowCloudTts: Schema.boolean().default(false),
  azureRegion: Schema.string().default(''),
  azureKeyEnv: Schema.string().default('AZURE_SPEECH_KEY'),
})

/** Every owned URL, including static assets and videos, crosses the real DSH fence. */
export function authenticatedHandler(core, connection, handler = handleRequest) {
  return async (req, res) => {
    const status = connection.requestRejection(req)
    if (status !== undefined) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: false, error: { code: status === 401 ? 'AUTH_REQUIRED' : 'FORBIDDEN', message: status === 401 ? 'Open the authenticated DSH application first.' : 'Request rejected.' } }))
      return
    }
    return handler(core, req, res)
  }
}

/** Host-owned callback, never a model tool. The HTTP owner must require human initiation. */
export function makeAgentStarter(core, ctx, isDisposed = () => false) {
  const start = async ({ projectId, prompt }) => {
    if (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) throw new Error('Invalid project identity')
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000) throw new Error('A bounded production prompt is required')
    // Read-only preflight never mounts a preset or starts a paid model request.
    if (!await start.ready() || isDisposed()) throw new Error('Paper Director agent is not configured')
    await core.dispatch('project.get', {}, { projectId })
    if (isDisposed()) throw new Error('Paper Director has stopped')
    const sessionId = `session-${randomUUID()}`
    const selected = ctx.agentDefaultModel.currentSelection()
    const handle = await ctx.agents.create({
      sessionId,
      meta: { agentPreset: 'paper-director' },
      agentOptions: { provider: selected.provider, model: selected.model, ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}) },
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'paper-director') },
    })
    try {
      if (isDisposed() || handle.agent.session.id !== sessionId) throw new Error('Agent session identity mismatch')
      await core.bindSession(sessionId, projectId)
      if (isDisposed() || !await core.isStudioSession(sessionId, projectId)) throw new Error('Agent binding unavailable')
      if (isDisposed() || ctx.agents.get(sessionId) !== handle.agent) throw new Error('Agent is no longer live')
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin', plugin: 'dsh-paper-director' },
      }))
      return { sessionId }
    } catch (error) {
      await handle.dispose()
      throw error
    }
  }
  start.ready = async () => {
    try {
      if (isDisposed()) return false
      const preset = await ctx.agentPresets.resolve('paper-director')
      if (isDisposed() || preset?.id !== 'paper-director' || preset.broken !== undefined) return false
      const selected = ctx.agentDefaultModel.currentSelection()
      return typeof selected?.provider === 'string' && !!selected.provider.trim() && typeof selected.model === 'string' && !!selected.model.trim()
    } catch { return false }
  }
  return start
}

const identity = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
const turnReasons = new Set(['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted'])
const emptyStatus = (liveStatus = 'cold') => ({ liveStatus, lastTurnReason: null, messages: [] })
const liveState = (agent) => agent?.status === 'running' ? 'running' : agent?.status === 'idle' ? 'idle' : 'cold'

/** Only Core-owned terminal facts enter the next turn; never interpolate errors/results. */
function noticeText(notice) {
  const { id, kind, status } = notice
  if (!identity(id)) return undefined
  if (kind === 'review') {
    if (status === 'approved') return `审阅 ${id}：作者已确认并应用修改。重新读取项目最新 revision，继续制作需要的新预览；不要重复申请同一修改。`
    if (status === 'dismissed') return `审阅 ${id}：作者选择保留原样。不要重新提出或应用同一剪短方案；仅继续其他已获授权的工作，否则简短确认后停止。`
    return undefined
  }
  if (!['align', 'narration', 'render'].includes(kind) || !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(status)) return undefined
  if (kind === 'render' && status === 'succeeded') return undefined
  if (status === 'succeeded') return `媒体任务 ${id}（${kind}）：succeeded。重新读取项目最新 revision 和任务结果，按作者已授权的制作要求继续；如已具备条件可开始渲染。不要轮询。`
  return `媒体任务 ${id}（${kind}）：${status}。读取本项目任务的安全状态并向作者说明阻碍；不要自动重试失败任务或重复渲染，等待作者决定。`
}

/** Attach once per injected Fiber. Core owns dedupe, not this delivery adapter. */
export function bindAgentLoop(core, ctx) {
  let disposed = false
  const stopped = () => disposed
  const starter = makeAgentStarter(core, ctx, stopped)
  const readStatus = async (sessionId) => {
    if (disposed || !identity(sessionId)) return emptyStatus()
    let projectId
    try {
      projectId = await core.bindingForSession(sessionId)
      if (disposed || !identity(projectId) || !await core.isStudioSession(sessionId, projectId)) return emptyStatus()
      if (disposed) return emptyStatus()
      const before = ctx.agents.get(sessionId)
      const persistence = ctx.get('sessionPersistence')
      const view = persistence ? await persistence.inspect(sessionId) : undefined
      if (disposed || !await core.isStudioSession(sessionId, projectId)) return emptyStatus()
      if (disposed) return emptyStatus()
      const agent = ctx.agents.get(sessionId)
      // Never combine an old inspection with a replacement Agent's surface.
      if (before !== agent) return emptyStatus(liveState(agent))
      const result = emptyStatus(liveState(agent))
      const session = agent?.session ?? ctx.get('sessions')?.get(sessionId)
      const events = view?.events
      if (events) for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]
        if (event.type !== 'turn/end') continue
        const reason = event.data?.reason?.kind
        result.lastTurnReason = turnReasons.has(reason) ? reason : null
        break
      }
      // Current SDK nodes are numeric seqs. The official fold excludes replaced
      // history even for cold inspections; never use raw assistant-event filtering.
      if (session && session.id !== sessionId) return result
      const nodes = session?.surface?.nodes ?? (events ? foldSurface(events).nodes : [])
      let remaining = 8000
      for (let i = nodes.length - 1; i >= 0 && result.messages.length < 10 && remaining > 0; i--) {
        const event = session ? session.eventAt(nodes[i]) : events[nodes[i]]
        if (event?.type !== 'assistant/message') continue
        const message = event.data?.message
        if (message?.role !== 'assistant' || message.source?.kind !== 'model' || !Array.isArray(message.content)) continue
        if (typeof message.id !== 'string' || !Number.isSafeInteger(event.seq)) continue
        let text = ''
        for (const block of message.content) {
          if (block.type === 'text' && typeof block.text === 'string') text += block.text.slice(0, remaining - text.length)
          if (text.length >= remaining) break
        }
        if (!text.trim()) continue
        result.messages.unshift({ id: message.id.slice(0, 128), seq: event.seq, text, interrupted: event.data.interrupted === true })
        remaining -= text.length
      }
      return result
    } catch {
      // No error messages, paths, provider payloads or partial assistant content.
      if (disposed) return emptyStatus()
      try { return emptyStatus(liveState(ctx.agents.get(sessionId))) } catch { return emptyStatus() }
    }
  }
  const deliver = async (notice) => {
    if (disposed) return { delivery: 'stopped' }
    try {
      const text = noticeText(notice)
      if (!text || !identity(notice.projectId) || !identity(notice.sessionId)) return { delivery: 'rejected' }
      const { projectId, sessionId } = notice
      if (!await core.isStudioSession(sessionId, projectId)) return { delivery: disposed ? 'stopped' : 'rejected' }
      if (disposed) return { delivery: 'stopped' }
      const agent = ctx.agents.get(sessionId)
      if (!agent) return { delivery: 'cold' }
      if (await core.bindingForSession(sessionId) !== projectId) return { delivery: disposed ? 'stopped' : 'rejected' }
      if (disposed) return { delivery: 'stopped' }
      if (ctx.agents.get(sessionId) !== agent) return { delivery: 'cold' }
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-paper-director' } }))
      return { delivery: 'queued' }
    } catch { return { delivery: disposed ? 'stopped' : 'rejected' } }
  }
  ctx.effect(() => {
    const unsubscribe = core.onAgentNotice(deliver)
    core.setAgentStarter(starter)
    core.setAgentStatusReader(readStatus)
    return () => {
      disposed = true
      unsubscribe()
      core.setAgentStarter(undefined)
      core.setAgentStatusReader(undefined)
    }
  }, 'paper-director: trusted agent loop')
}

/** One process-level persistence/media owner. Agent presets consume, never provide it. */
export class PaperDirector extends Service {
  static Config = Config
  constructor(ctx, config) {
    super(ctx, 'paperDirector')
    this.core = new PaperDirectorCore(config)
  }
  async [Service.init]() {
    const core = this.core
    // Register cleanup before awaiting init so a partial initialization is also unwound.
    this.ctx.effect(() => () => core.close(), 'paper-director: core lifecycle')
    await core.init()
    this.ctx.inject(['webServer', 'connection'], (webCtx) => {
      const handler = authenticatedHandler(core, webCtx.connection)
      webCtx.effect(() => webCtx.webServer.register({ kind: 'prefix', path: '/paper-director/', handler }), 'paper-director: studio routes')
      webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: '/paper-director', handler }), 'paper-director: studio root')
    })
    this.ctx.inject(['agents', 'agentPresets', 'agentDefaultModel'], (agentCtx) => {
      bindAgentLoop(core, agentCtx)
    })
  }
  dispatch(operation, args, scope) { return this.core.dispatch(operation, args, scope) }
  bindingForSession(sessionId) { return this.core.bindingForSession(sessionId) }
}

export default PaperDirector
