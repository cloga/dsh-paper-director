import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const sdkRoot = process.env.DSH_ADAPTER_SDK_ROOT
const sdkAvailable = sdkRoot || existsSync(new URL('../node_modules/@deepseek-ai/dsh-session/package.json', import.meta.url))
const skip = sdkAvailable ? false : 'Explicit exact DSH 0.1.2-rc.1 SDK link is required'
async function sdk(name) {
  if (sdkRoot) return import(pathToFileURL(join(sdkRoot, name, 'lib/index.js')).href)
  // Persistence is a Host SDK dependency, not an additional plugin dependency.
  if (name === 'dsh-session-persistence') return import(new URL('../../dsh-session-persistence/lib/index.js', import.meta.resolve('@deepseek-ai/dsh-session')).href)
  return import(`@deepseek-ai/${name}`)
}
async function adapter() {
  const { foldSurface, Session } = await sdk('dsh-session')
  const llm = await sdk('dsh-llm')
  const source = (await readFile(new URL('../index.js', import.meta.url), 'utf8')).replace(/^import .*\n/gm, '').replace(/export default PaperDirector\s*$/m, '').replace(/^export /gm, '')
  const schemaNode = () => ({ default() { return this } })
  const Schema = { object: schemaNode, string: schemaNode, boolean: schemaNode, union: schemaNode }
  const functions = new Function('Service', 'Schema', 'createUserMessage', 'foldSurface', 'randomUUID', `${source}\nreturn {bindAgentLoop,makeAgentStarter};`)(class {}, Schema, llm.createUserMessage, foldSurface, () => 'test-id')
  return { ...functions, Session, ...llm }
}
async function fixture(options = {}) {
  const api = await adapter(), effects = [], sent = []
  let live = options.agent ?? { session: { id: 's1' }, status: 'idle', followup: (message) => sent.push(message) }
  const f = { sent, effects, binding: 'p1', studio: true, inspectCount: 0, unregistered: 0, get live() { return live }, set live(value) { live = value } }
  f.core = {
    bindingForSession: async () => f.binding,
    isStudioSession: async (sid, pid) => sid === 's1' && f.studio && pid === f.binding,
    setAgentStarter: (fn) => { f.starter = fn }, setAgentStatusReader: (fn) => { f.reader = fn },
    onAgentNotice: (fn) => { f.notice = fn; return () => { f.unregistered++ } },
  }
  f.ctx = {
    agents: { get: () => live, create: () => assert.fail('must not create'), resume: () => assert.fail('must not resume') },
    agentPresets: { resolve: async () => ({ id: 'paper-director' }), mount: () => assert.fail('health must not mount'), standingKeyFor: () => assert.fail('health must not mount') },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'offline' }) },
    get(name) { return name === 'sessionPersistence' ? { inspect: async (sid) => { f.inspectCount++; return f.inspect(sid) } } : undefined },
    effect(fn) { effects.push(fn()) },
  }
  f.inspect = async () => ({ meta: {}, inheritedEventCount: 0, events: [] })
  f.dispose = () => { for (const fn of effects.reverse()) fn() }
  api.bindAgentLoop(f.core, f.ctx)
  return { ...api, f }
}
const notice = (kind = 'align', status = 'succeeded') => ({ id: 'j1', projectId: 'p1', sessionId: 's1', kind, status })
const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

test('native SDK version and exports match the explicitly supported contract', { skip }, async () => {
  for (const name of ['dsh-session', 'dsh-llm']) {
    const location = sdkRoot ? pathToFileURL(join(sdkRoot, name, 'package.json')) : new URL(`../node_modules/@deepseek-ai/${name}/package.json`, import.meta.url)
    assert.equal(JSON.parse(await readFile(location, 'utf8')).version, '0.1.2-rc.1')
  }
  const { Session, foldSurface } = await sdk('dsh-session')
  assert.equal(typeof Session.create, 'function'); assert.equal(typeof foldSurface, 'function')
})

test('notices use native plugin-provenance messages, continue alignment/narration, never rerender success', { skip }, async () => {
  const { f } = await fixture()
  for (const kind of ['align', 'narration']) assert.deepEqual(await f.notice(notice(kind)), { delivery: 'queued' })
  assert.deepEqual(await f.notice(notice('render')), { delivery: 'rejected' })
  assert.deepEqual(await f.notice(notice('render', 'failed')), { delivery: 'queued' })
  for (const status of ['approved', 'dismissed']) assert.deepEqual(await f.notice(notice('review', status)), { delivery: 'queued' })
  assert.equal(f.sent.length, 5)
  for (const m of f.sent) { assert.equal(m.role, 'user'); assert.equal(m.source.kind, 'plugin'); assert.equal(m.source.plugin, 'dsh-paper-director'); assert.equal(m.content[0].type, 'text') }
  assert.match(f.sent[3].content[0].text, /确认并应用/); assert.match(f.sent[4].content[0].text, /保留原样/)
  assert.match(f.sent[2].content[0].text, /不要自动重试/)
  f.dispose(); assert.equal(f.unregistered, 1); assert.equal(f.reader, undefined); assert.equal(f.starter, undefined)
  assert.deepEqual(await f.notice(notice()), { delivery: 'stopped' })
})

test('real Cordis Fiber owns listener and cancels an in-flight callback on disposal', { skip }, async () => {
  const { Context } = await sdk('cordis')
  const { f, bindAgentLoop } = await fixture(); f.dispose(); f.effects.length = 0
  const root = new Context(); const wait = gate()
  const plugin = root.plugin({ name: 'offline-paper-loop-test', apply(ctx) {
    bindAgentLoop(f.core, { ...f.ctx, effect: (fn, label) => ctx.effect(fn, label) })
  } })
  await plugin
  const reader = f.reader
  f.core.bindingForSession = async () => { await wait.promise; return 'p1' }
  const delivery = f.notice(notice()); await Promise.resolve(); await Promise.resolve()
  await plugin.dispose(); wait.resolve()
  assert.deepEqual(await delivery, { delivery: 'stopped' })
  assert.deepEqual(await reader('s1'), { liveStatus: 'cold', lastTurnReason: null, messages: [] })
  assert.equal(f.unregistered, 2); assert.equal(f.reader, undefined); assert.equal(f.starter, undefined); assert.equal(f.sent.length, 0)
})

test('cold/admin/wrong-project/invalid notices never resume or expose payloads', { skip }, async () => {
  const { f } = await fixture()
  f.live = undefined; assert.deepEqual(await f.notice(notice()), { delivery: 'cold' })
  f.studio = false; assert.deepEqual(await f.notice(notice()), { delivery: 'rejected' })
  f.studio = true; assert.deepEqual(await f.notice({ ...notice(), projectId: 'p2' }), { delivery: 'rejected' })
  assert.deepEqual(await f.notice({ ...notice(), id: 'private\npath' }), { delivery: 'rejected' })
  f.core.isStudioSession = async () => { throw new Error('SECRET provider payload') }
  assert.deepEqual(await f.notice(notice()), { delivery: 'rejected' }); assert.equal(f.sent.length, 0)
})

test('notice rechecks disposal, project binding and exact live agent after awaited checks', { skip }, async () => {
  for (const mode of ['disposed', 'binding', 'live']) {
    const { f } = await fixture(); const wait = gate()
    f.core.bindingForSession = async () => { await wait.promise; return f.binding }
    const task = f.notice(notice()); await Promise.resolve(); await Promise.resolve()
    if (mode === 'disposed') f.dispose()
    if (mode === 'binding') f.binding = 'p2'
    if (mode === 'live') f.live = { followup: () => assert.fail('replacement must not receive old notice') }
    wait.resolve(); const result = await task
    assert.equal(result.delivery, mode === 'disposed' ? 'stopped' : mode === 'binding' ? 'rejected' : 'cold'); assert.equal(f.sent.length, 0)
  }
})

async function nativeSession(api) {
  const session = api.Session.create('s1')
  const assistant = (text, options = {}) => session.append('assistant/message', {
    turn: 1, step: 1, message: api.createAssistantMessage({ content: [{ type: 'reasoning', text: 'SECRET reasoning' }, { type: 'text', text }, { type: 'tool-call', id: 'call1', name: 'private-tool', arguments: { secret: 'SECRET' } }], source: { provider: 'fixture', model: 'offline' } }), ...options,
  }, { surfaceOp: 'append', sourceEventSeqs: [] })
  const old = assistant('REPLACED history')
  session.append('assistant/message', { turn: 1, step: 1, message: api.createAssistantMessage({ content: [{ type: 'text', text: 'Current answer' }], source: { provider: 'fixture', model: 'offline' } }) }, { surfaceOp: { op: 'replace', start: old.seq, end: old.seq }, sourceEventSeqs: [old.seq] })
  session.append('user/message', { message: api.createUserMessage({ content: [{ type: 'text', text: 'SECRET user' }], source: { kind: 'user' } }) }, { surfaceOp: 'append' })
  session.append('assistant/message', { message: api.createMessage({ role: 'assistant', content: [{ type: 'text', text: 'SECRET plugin' }], source: { kind: 'plugin', plugin: 'fixture' } }) }, { surfaceOp: 'append', sourceEventSeqs: [] })
  assistant('Partial visible answer', { interrupted: true })
  session.append('turn/end', { turn: 1, reason: { kind: 'error', error: 'SECRET path/provider payload' } })
  return session
}

test('native Session surface seqs and event.data.message yield text only; cold fold excludes replacements', { skip }, async () => {
  const { f, ...api } = await fixture(); const session = await nativeSession(api)
  assert.ok(session.surface.nodes.every((seq) => Number.isInteger(seq)))
  // Fail loudly on any attempt to enumerate or stringify internal Session/Event.
  const guard = (object) => new Proxy(object, { ownKeys() { assert.fail('live object enumeration') }, get(target, key) { if (key === 'toJSON') assert.fail('live object serialization'); return Reflect.get(target, key) } })
  // Exercise the installed persistence implementation's live view, not an
  // invented snapshot/getSnapshot/events wrapper contract.
  const { PersistenceCoordinator } = await sdk('dsh-session-persistence')
  const inspection = await PersistenceCoordinator.prototype.inspect.call({
    retirements: new Map(), ctx: { sessions: { get: () => session } },
    inspectLive: PersistenceCoordinator.prototype.inspectLive,
  }, 's1')
  assert.deepEqual(Object.keys(inspection), ['meta', 'inheritedEventCount', 'events'])
  assert.equal(inspection.events, session.snapshotEvents())
  const events = inspection.events.map(guard)
  f.inspect = async () => ({ meta: { private: 'SECRET' }, inheritedEventCount: inspection.inheritedEventCount, events })
  f.live.session = new Proxy(session, { ownKeys() { assert.fail('session enumeration') }, get(target, key) { if (key === 'toJSON') assert.fail('session serialization'); if (key === 'eventAt') return (seq) => guard(target.eventAt(seq)); return Reflect.get(target, key) } })
  for (const state of ['idle', 'running', 'cold']) {
    if (state === 'cold') f.live = undefined; else f.live.status = state
    const result = await f.reader('s1')
    assert.equal(result.liveStatus, state); assert.equal(result.lastTurnReason, 'error')
    assert.deepEqual(result.messages.map((m) => [m.text, m.interrupted]), [['Current answer', false], ['Partial visible answer', true]])
    assert.doesNotMatch(JSON.stringify(result), /SECRET|REPLACED|reasoning|private-tool/)
    assert.deepEqual(Object.keys(result), ['liveStatus', 'lastTurnReason', 'messages'])
  }
})

test('reader refuses administrator history and loses no privacy after inspect races or safe errors', { skip }, async () => {
  for (const mode of ['admin', 'disposed', 'binding', 'live', 'error']) {
    const { f, ...api } = await fixture(); const session = await nativeSession(api); f.live.session = session
    if (mode === 'admin') { f.studio = false; assert.deepEqual(await f.reader('s1'), { liveStatus: 'cold', lastTurnReason: null, messages: [] }); assert.equal(f.inspectCount, 0); continue }
    const wait = gate(); f.inspect = async () => { await wait.promise; if (mode === 'error') throw new Error('SECRET path'); return { events: session.snapshotEvents() } }
    const reader = f.reader; const task = reader('s1'); for (let i = 0; i < 5; i++) await Promise.resolve()
    if (mode === 'disposed') f.dispose()
    if (mode === 'binding') f.binding = 'p2'
    if (mode === 'live') f.live = { session, status: 'running' }
    wait.resolve(); const result = await task
    assert.deepEqual(result.messages, []); assert.equal(result.lastTurnReason, null); assert.doesNotMatch(JSON.stringify(result), /SECRET/)
  }
})

test('reader limits recent effective text to ten messages and 8000 characters, whitelists reasons', { skip }, async () => {
  const { f, ...api } = await fixture(); const session = api.Session.create('s1'); f.live.session = session
  for (let i = 0; i < 12; i++) session.append('assistant/message', { message: api.createAssistantMessage({ content: [{ type: 'text', text: `${i}:` + 'x'.repeat(998) }], source: { provider: 'fixture', model: 'offline' } }) }, { surfaceOp: 'append', sourceEventSeqs: [] })
  session.append('turn/end', { reason: { kind: 'SECRET invalid reason' } })
  f.inspect = async () => ({ events: session.snapshotEvents() })
  const result = await f.reader('s1'); assert.equal(result.lastTurnReason, null); assert.ok(result.messages.length <= 10); assert.equal(result.messages.reduce((n, m) => n + m.text.length, 0), 8000); assert.match(result.messages.at(-1).text, /^11:/)
  const short = api.Session.create('s1'); f.live.session = short
  for (let i = 0; i < 12; i++) short.append('assistant/message', { message: api.createAssistantMessage({ content: [{ type: 'text', text: String(i) }], source: { provider: 'fixture', model: 'offline' } }) }, { surfaceOp: 'append', sourceEventSeqs: [] })
  f.inspect = async () => ({ events: short.snapshotEvents() })
  const bounded = await f.reader('s1'); assert.equal(bounded.messages.length, 10); assert.equal(bounded.messages[0].text, '2'); assert.equal(bounded.messages.at(-1).text, '11')
})

test('ready checks preset broken flag and complete model selection without mounting', { skip }, async () => {
  const { f } = await fixture(); assert.equal(await f.starter.ready(), true)
  for (const preset of [{ id: 'wrong' }, { id: 'paper-director', broken: '' }, { id: 'paper-director', broken: 'SECRET absolute path' }]) { f.ctx.agentPresets.resolve = async () => preset; assert.equal(await f.starter.ready(), false) }
  f.ctx.agentPresets.resolve = async () => ({ id: 'paper-director' })
  for (const selection of [{}, { provider: 'p' }, { provider: ' ', model: 'm' }]) { f.ctx.agentDefaultModel.currentSelection = () => selection; assert.equal(await f.starter.ready(), false) }
  f.ctx.agentPresets.resolve = async () => { throw new Error('SECRET path') }; assert.equal(await f.starter.ready(), false)
})
