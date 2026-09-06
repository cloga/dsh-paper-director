import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const root = new URL('../', import.meta.url)
const read = (name) => readFile(new URL(name, root), 'utf8')
const schemaNode = () => ({ default() { return this } })
const Schema = { object: schemaNode, string: schemaNode, boolean: schemaNode, union: schemaNode }

// Load only the adapter under explicit contract doubles. This does not import or
// mount the running Harness, start a server, or initialize a real media project.
async function loadHost(Core = class {}) {
  const source = (await read('index.js')).replace(/^import .*\n/gm, '').replace(/export default PaperDirector\s*$/m, '').replace(/^export /gm, '')
  class Service {
    static init = Symbol('init')
    constructor(ctx) { this.ctx = ctx }
  }
  const run = new Function('Service', 'Schema', 'PaperDirectorCore', 'handleRequest', 'randomUUID', 'createUserMessage', `${source}\nreturn {PaperDirector, authenticatedHandler, makeAgentStarter};`)
  return { ...run(Service, Schema, Core, () => {}, () => 'test-id', (message) => message), Service }
}
async function loadTools() {
  const source = (await read('src/tools.js')).replace(/^import .*\n/gm, '').replace(/^export /gm, '')
  return new Function('defineTool', 'Schema', `${source}\nreturn {apply,Config};`)((tool) => tool, Schema)
}
function context(services = {}) {
  const effects = []
  const ctx = { ...services, effects, effect(fn) { const disposer = fn(); effects.push(disposer); return disposer }, inject(names, fn) { if (names.every((name) => ctx[name] !== undefined)) return fn(ctx) } }
  return ctx
}
function response() {
  return { status: undefined, body: undefined, writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { this.body = body } }
}

test('all static/API/media requests are rejected before core when DSH rejects', async () => {
  const { authenticatedHandler } = await loadHost()
  for (const url of ['/paper-director/', '/paper-director/static/app.js', '/paper-director/api/projects/p/assets/a']) {
    for (const status of [401, 403]) {
      let called = false
      const req = { url }; const res = response()
      await authenticatedHandler({}, { requestRejection(value) { assert.equal(value, req); return status } }, () => { called = true })(req, res)
      assert.equal(called, false); assert.equal(res.status, status)
      assert.equal(JSON.parse(res.body).ok, false)
    }
  }
})
test('accepted requests delegate once and preserve handler arguments', async () => {
  const { authenticatedHandler } = await loadHost(); const core = {}; const req = {}; const res = response()
  let count = 0
  await authenticatedHandler(core, { requestRejection: () => undefined }, (c, q, s) => { assert.equal(c, core); assert.equal(q, req); assert.equal(s, res); count++ })(req, res)
  assert.equal(count, 1)
})
test('Host init owns one core and route disposal, no Host model tools', async () => {
  let initialized = 0; let closed = 0; const routes = []
  class Core { async init() { initialized++ } close() { closed++ } }
  const { PaperDirector, Service } = await loadHost(Core)
  const ctx = context({ connection: { requestRejection: () => undefined }, webServer: { register(route) { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } } } })
  const host = new PaperDirector(ctx, {})
  await host[Service.init]()
  assert.equal(initialized, 1); assert.equal(routes.length, 2)
  assert.deepEqual(routes.map((r) => r.path), ['/paper-director/', '/paper-director'])
  for (const cleanup of [...ctx.effects].reverse()) await cleanup?.()
  assert.equal(routes.length, 0); assert.equal(closed, 1)
})
test('partial core init still has registered cleanup', async () => {
  let closed = false
  class Core { async init() { throw new Error('init failed') } close() { closed = true } }
  const { PaperDirector, Service } = await loadHost(Core); const ctx = context()
  const host = new PaperDirector(ctx, {})
  await assert.rejects(host[Service.init](), /init failed/)
  for (const cleanup of ctx.effects) await cleanup?.()
  assert.equal(closed, true)
})
test('human Agent bridge fixes preset, mounts it, binds before followup', async () => {
  const { makeAgentStarter } = await loadHost(); const events = []
  const core = { dispatch: async (op, args, scope) => { assert.equal(op, 'project.get'); assert.equal(scope.projectId, 'p1') }, bindSession: async (sid, pid) => { assert.equal(pid, 'p1'); events.push('bind') } }
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'local' }) },
    agentPresets: { async mount(agentCtx, id) { assert.equal(id, 'paper-director'); events.push('mount') } },
    agents: { async create(options) { assert.equal(options.meta.agentPreset, 'paper-director'); await options.setup({}); return { agent: { session: { id: options.sessionId }, followup(message) { assert.deepEqual(events, ['mount', 'bind']); assert.equal(message.source.kind, 'plugin'); events.push('followup') } }, async dispose() {} } } },
  }
  const result = await makeAgentStarter(core, ctx)({ projectId: 'p1', prompt: '请制作预览' })
  assert.equal(result.sessionId, 'session-test-id'); assert.deepEqual(events, ['mount', 'bind', 'followup'])
})
test('Agent bridge disposes failed delivery and never sends before binding succeeds', async () => {
  const { makeAgentStarter } = await loadHost(); let disposed = false; let sent = false
  const core = { dispatch: async () => {}, bindSession: async () => { throw new Error('binding failed') } }
  const ctx = { agentDefaultModel: { currentSelection: () => ({}) }, agentPresets: {}, agents: { async create(options) { return { agent: { session: { id: options.sessionId }, followup() { sent = true } }, async dispose() { disposed = true } } } } }
  await assert.rejects(makeAgentStarter(core, ctx)({ projectId: 'p1', prompt: 'preview' }), /binding failed/)
  assert.equal(sent, false); assert.equal(disposed, true)
})

async function toolsFixture(config = {}) {
  const tools = new Map(); const calls = []; const restrictions = []
  const { apply } = await loadTools()
  apply({ tools: { restrict: (filter) => restrictions.push(filter), register: (tool) => tools.set(tool.name, tool) }, paperDirector: { bindingForSession: (id) => ({ s1: 'p1', s2: 'p2' })[id], async dispatch(op, args, scope) { calls.push({ op, args, scope }); return { ok: true } } } }, config)
  return { tools, calls, restrictions, run: (name, args = {}, sid = 's1') => tools.get(name).execute(args, { agent: { session: { id: sid } } }) }
}
test('two sessions cannot select each other’s projects and inherited tools are masked', async () => {
  const f = await toolsFixture()
  assert.deepEqual(f.restrictions, [{ allow: [] }]); assert.equal(f.tools.size, 8)
  await assert.rejects(f.run('paper_project', { projectId: 'p2' }, 's1'), /Unknown media/)
  await assert.rejects(f.run('paper_project', { projectId: 'p1' }, 's2'), /Unknown media/)
  await f.run('paper_project', {}, 's1')
  await f.run('paper_project', {}, 's2')
  assert.deepEqual(f.calls.map((call) => call.scope), [{ projectId: 'p1' }, { projectId: 'p2' }])
  assert.deepEqual(f.calls.map((call) => call.args), [{}, {}])
  await assert.rejects(f.run('paper_project', {}, 'unknown'), /No trusted project binding/)
  assert.equal(f.calls.length, 2)
})
test('administrator binding is not a tool parameter', async () => {
  const f = await toolsFixture({ projectId: 'admin-project' }); await f.run('paper_project')
  assert.equal(f.calls[0].scope.projectId, 'admin-project')
  for (const tool of f.tools.values()) {
    for (const forbidden of ['projectId', 'path', 'command', 'azureKeyEnv', 'allowUnmatchedSpeech']) assert.equal(Object.hasOwn(tool.parameters, forbidden), false)
  }
})
test('pause tools cannot authorize unmatched speech or accept forged cut ranges', async () => {
  const f = await toolsFixture()
  await assert.rejects(f.run('paper_pause_apply', { expectedRevision: 2, afterDialogueId: 'd1', beforeDialogueId: 'd2', targetSeconds: 1, allowUnmatchedSpeech: true, start: 0, end: 999 }), /Unknown media/)
  await f.run('paper_pause_apply', { expectedRevision: 2, afterDialogueId: 'd1', beforeDialogueId: 'd2', targetSeconds: 1 })
  assert.deepEqual(f.calls[0].args, { expectedRevision: 2, operation: { type: 'shorten_pause', afterDialogueId: 'd1', beforeDialogueId: 'd2', targetSeconds: 1 }, allowUnmatchedSpeech: false })
  await assert.rejects(f.run('paper_pause_apply', { expectedRevision: 2, afterDialogueId: 'd1', beforeDialogueId: 'd2', targetSeconds: -1 }), /Invalid target/)
})
test('story patch refuses transport paths and speech-deletion escape hatches', async () => {
  const f = await toolsFixture()
  for (const patchJson of ['{"projectId":"p2"}', '{"scenes":[{"path":"secret"}]}', '{"style":{"allowUnmatchedSpeech":true}}', '{"__proto__":{}}']) {
    await assert.rejects(f.run('paper_update_story', { expectedRevision: 1, patchJson }), /protected|forbidden/)
  }
  await f.run('paper_update_story', { expectedRevision: 1, patchJson: '{"title":"我的故事"}' })
  assert.deepEqual(f.calls[0].args, { expectedRevision: 1, patch: { title: '我的故事' } })
})
test('job and narration calls remain narrowly scoped', async () => {
  const f = await toolsFixture()
  await f.run('paper_jobs', { action: 'cancel', jobId: 'job1' })
  assert.equal(f.calls[0].op, 'job.cancel'); assert.deepEqual(f.calls[0].args, { jobId: 'job1' })
  await assert.rejects(f.run('paper_narration', { expectedRevision: 1, text: '从前', voiceProfile: 'unsafe', azureKeyEnv: 'OTHER' }), /Unknown media/)
  await f.run('paper_narration', { expectedRevision: 1, text: '从前' })
  assert.deepEqual(f.calls[1].args, { expectedRevision: 1, text: '从前', voiceProfile: 'narrator' })
})
test('Client is a single small ModuleLoader factory requiring only React', async () => {
  const source = await read('lib/client.js'); let registration
  const requireNames = []; const slots = []
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: (value) => { registration = value } } } })
  assert.equal(registration.id, 'dsh-paper-director')
  const plugin = registration.factory((id) => { requireNames.push(id); assert.equal(id, 'react'); return { createElement: (tag, props, ...children) => ({ tag, props, children }) } })
  plugin.apply({ slots: { inject: (name, fn) => fn(), register: (options, component) => { slots.push({ options, component }); return () => {} } } })
  assert.deepEqual(requireNames, ['react']); assert.equal(slots[0].options.name, 'sidebar.footer.action')
  assert.equal(slots[0].options.inject, undefined, 'root entry inject receives no slot props')
  assert.equal(slots[0].component({ wide: true }).props.href, '/paper-director/')
  assert.ok(Buffer.byteLength(source) < 3000)
  assert.doesNotMatch(source, /__DSH_BOOT__|createRoot|react-dom|vite|fetch\(/)
})
test('bundle contributes Host only and preset contributes no unsafe provider/tool', async () => {
  const bundle = await read('cordis.patch.yml'); const preset = await read('presets/paper-director/agent.cordis.yml')
  assert.match(bundle, /name: dsh-paper-director\s/); assert.doesNotMatch(bundle, /dsh-paper-director\/tools/)
  assert.match(preset, /name: dsh-paper-director\/tools/)
  assert.doesNotMatch(preset, /name:.*(?:dsh-tool-(?:bash|pwsh|fs|web|subagent)|dsh-fs-local|dsh-sandbox)/)
  assert.match(preset, /complete: true/)
})
