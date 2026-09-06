import { randomUUID } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
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
export function makeAgentStarter(core, ctx) {
  return async ({ projectId, prompt }) => {
    if (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) throw new Error('Invalid project identity')
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000) throw new Error('A bounded production prompt is required')
    // Verify existence before constructing a session. There is no model-selected preset.
    await core.dispatch('project.get', {}, { projectId })
    const sessionId = `session-${randomUUID()}`
    const selected = ctx.agentDefaultModel.currentSelection()
    const handle = await ctx.agents.create({
      sessionId,
      meta: { agentPreset: 'paper-director' },
      agentOptions: { provider: selected.provider, model: selected.model, ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}) },
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'paper-director') },
    })
    try {
      if (String(handle.agent.session.id) !== sessionId) throw new Error('Agent session identity mismatch')
      await core.bindSession(sessionId, projectId)
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
      core.setAgentStarter(makeAgentStarter(core, agentCtx))
      agentCtx.effect(() => () => core.setAgentStarter(undefined), 'paper-director: agent starter')
    })
  }
  dispatch(operation, args, scope) { return this.core.dispatch(operation, args, scope) }
  bindingForSession(sessionId) { return this.core.bindingForSession(sessionId) }
}

export default PaperDirector
