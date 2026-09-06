import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const sdkRoot = process.env.DSH_ADAPTER_SDK_ROOT
const skip = sdkRoot ? false : 'Set DSH_ADAPTER_SDK_ROOT for installed DSH 0.1.2-rc.1 schema validation'

test('actual DSH defineTool accepts all restricted tool schemas', { skip }, async () => {
  const { defineTool } = await import(pathToFileURL(join(sdkRoot, 'dsh-tools/lib/index.js')).href)
  const { default: Schema } = await import(pathToFileURL(join(sdkRoot, 'schemastery/lib/index.mjs')).href)
  const source = (await readFile(new URL('../src/tools.js', import.meta.url), 'utf8')).replace(/^import .*\n/gm, '').replace(/^export /gm, '')
  const { apply, Config } = new Function('defineTool', 'Schema', `${source}\nreturn {apply,Config};`)(defineTool, Schema)
  const registered = new Map(); const calls = []
  const config = Config({})
  assert.equal(config.projectId, '')
  apply({ tools: { restrict: (filter) => assert.deepEqual(filter, { allow: [] }), register: (tool) => registered.set(tool.name, tool) }, paperDirector: { bindingForSession: () => 'p1', dispatch: async (op, args, scope) => { calls.push({ op, args, scope }); return { id: 'p1', revision: 0 } } } }, config)
  assert.equal(registered.size, 8)
  const exec = { agent: { session: { id: 's1' } } }
  await registered.get('paper_project').execute({}, exec)
  await assert.rejects(registered.get('paper_project').execute({ projectId: 'p2' }, exec))
  await assert.rejects(registered.get('paper_render').execute({ expectedRevision: 1.2 }, exec))
  await assert.rejects(registered.get('paper_jobs').execute({ action: 'shell' }, exec))
  await registered.get('paper_pause_apply').execute({ expectedRevision: 1, afterDialogueId: 'd1', beforeDialogueId: 'd2', targetSeconds: 0.5 }, exec)
  assert.equal(calls.at(-1).args.allowUnmatchedSpeech, false)
})

test('actual Schemastery validates Host defaults and rejects cloud config type drift', { skip }, async () => {
  const { default: Schema } = await import(pathToFileURL(join(sdkRoot, 'schemastery/lib/index.mjs')).href)
  const source = (await readFile(new URL('../index.js', import.meta.url), 'utf8')).replace(/^import .*\n/gm, '').replace(/export default PaperDirector\s*$/m, '').replace(/^export /gm, '')
  class Service { static init = Symbol('init') }
  const Config = new Function('Schema', 'Service', `${source}\nreturn Config;`)(Schema, Service)
  assert.equal(Config({}).allowCloudTts, false)
  assert.equal(Config({}).asrEngine, 'whisper')
  assert.throws(() => Config({ allowCloudTts: 'true' }))
  assert.throws(() => Config({ asrEngine: 'shell' }))
})
