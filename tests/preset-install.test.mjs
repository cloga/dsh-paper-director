import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { installPreset, parseArguments, PRESET_FILES } from '../scripts/install-preset.mjs'

const packagedSource = fileURLToPath(new URL('../presets/paper-director/', import.meta.url))
async function temporary(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'paper-preset-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
async function makeLink(t, destination, link, directory = true) {
  try { await symlink(destination, link, directory && process.platform === 'win32' ? 'junction' : directory ? 'dir' : 'file') }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`OS cannot create test symlink: ${error.code}`); return false }
    throw error
  }
  return true
}

test('installer import is inert and CLI validates explicit arguments', () => {
  assert.deepEqual(parseArguments(['--root', './owned', '--dry-run']), { root: './owned', dryRun: true })
  for (const args of [['--root'], ['--root', '--dry-run'], ['--root', 'a', '--root', 'b'], ['--force'], ['--dry-run', '--dry-run']]) assert.throws(() => parseArguments(args))
})

test('dry-run verifies packaged resources without creating any destination', async (t) => {
  const temp = await temporary(t)
  const root = path.join(temp, 'not-created', '.agent-presets')
  const result = await installPreset({ root, dryRun: true })
  assert.equal(result.target, path.join(root, 'paper-director'))
  assert.equal(result.dryRun, true)
  assert.deepEqual(result.files, PRESET_FILES)
  assert.deepEqual(await readdir(temp), [])
})

test('real filesystem install copies exactly the two immutable package resources', async (t) => {
  const temp = await temporary(t)
  const result = await installPreset({ root: path.join(temp, '.agent-presets') })
  assert.deepEqual((await readdir(result.target)).sort(), [...PRESET_FILES].sort())
  for (const name of PRESET_FILES) assert.deepEqual(await readFile(path.join(result.target, name)), await readFile(path.join(packagedSource, name)))
  await assert.rejects(installPreset({ root: result.root }), /already exists/)
  await assert.rejects(installPreset({ root: result.root, dryRun: true }), /already exists/)
})

test('DSH_HOME and home fallback use only the explicit temporary test home', async (t) => {
  const temp = await temporary(t)
  const configured = await installPreset({ env: { DSH_HOME: path.join(temp, 'custom') }, home: path.join(temp, 'unused') })
  assert.equal(configured.target, path.join(temp, 'custom', '.agent-presets', 'paper-director'))
  const fallback = await installPreset({ env: {}, home: path.join(temp, 'home') })
  assert.equal(fallback.target, path.join(temp, 'home', '.dsh', '.agent-presets', 'paper-director'))
  await assert.rejects(installPreset({ env: { DSH_HOME: '' }, home: temp }), /empty/)
})

test('explicit root takes precedence and rejects package/shipped/final/root locations', async (t) => {
  const temp = await temporary(t)
  const result = await installPreset({ root: path.join(temp, 'custom-roster'), env: { DSH_HOME: '' } })
  assert.equal(result.root, path.join(temp, 'custom-roster'))
  for (const root of [path.join(temp, 'agent-presets'), path.join(temp, 'presets'), path.join(temp, 'node_modules', 'x'), path.join(temp, 'paper-director'), path.parse(temp).root, '']) {
    await assert.rejects(installPreset({ root, dryRun: true }), /root|shipped|nonempty/)
  }
})

test('existing file or directory target is never overwritten', async (t) => {
  const temp = await temporary(t)
  const root = path.join(temp, 'roster'); await mkdir(root)
  const target = path.join(root, 'paper-director')
  await writeFile(target, 'preserve me')
  await assert.rejects(installPreset({ root }), /already exists/)
  assert.equal(await readFile(target, 'utf8'), 'preserve me')
  await assert.rejects(installPreset({ root: path.join(target, 'nested') }), /plain directory/)
})

test('root and intermediate directory symlinks/junctions are rejected without writes', async (t) => {
  const temp = await temporary(t)
  const outside = path.join(temp, 'outside'); await mkdir(outside)
  const link = path.join(temp, 'redirect')
  if (!await makeLink(t, outside, link)) return
  await assert.rejects(installPreset({ root: link }), /plain directory/)
  await assert.rejects(installPreset({ root: path.join(link, 'nested') }), /plain directory/)
  await assert.rejects(installPreset({ root: link, dryRun: true }), /plain directory/)
  assert.deepEqual(await readdir(outside), [])
})

test('dangling target symlink is considered an existing destination', async (t) => {
  const temp = await temporary(t)
  const root = path.join(temp, 'roster'); await mkdir(root)
  if (!await makeLink(t, path.join(temp, 'missing'), path.join(root, 'paper-director'))) return
  await assert.rejects(installPreset({ root }), /already exists/)
  assert.equal(existsSync(path.join(temp, 'missing')), false)
})

test('source directories and resource links are rejected, extra files never copied', async (t) => {
  const temp = await temporary(t)
  const source = path.join(temp, 'source'); await mkdir(source)
  await writeFile(path.join(source, 'agent.cordis.yml'), 'test composition')
  await writeFile(path.join(source, 'preset.yml'), 'name: Test')
  await writeFile(path.join(source, '.env'), 'not a preset resource')
  const result = await installPreset({ root: path.join(temp, 'clean-roster'), source })
  assert.deepEqual((await readdir(result.target)).sort(), [...PRESET_FILES].sort())
  const linkedSource = path.join(temp, 'source-link')
  if (!await makeLink(t, source, linkedSource)) return
  await assert.rejects(installPreset({ root: path.join(temp, 'rejected-roster'), source: linkedSource }), /plain directory/)
  assert.equal(existsSync(path.join(temp, 'rejected-roster')), false)
})

test('missing or directory-shaped resource fails before any destination is made', async (t) => {
  const temp = await temporary(t)
  const source = path.join(temp, 'source'); await mkdir(source)
  const root = path.join(temp, 'roster')
  await assert.rejects(installPreset({ root, source }), /ENOENT/)
  await mkdir(path.join(source, 'agent.cordis.yml'))
  await assert.rejects(installPreset({ root, source }), /Invalid packaged/)
  assert.equal(existsSync(root), false)
})

test('oversized packaged resources fail before creating a user root', async (t) => {
  const temp = await temporary(t)
  const source = path.join(temp, 'source'); await mkdir(source)
  await writeFile(path.join(source, 'agent.cordis.yml'), Buffer.alloc(1024 * 1024 + 1))
  await writeFile(path.join(source, 'preset.yml'), 'name: Test')
  const root = path.join(temp, 'roster')
  await assert.rejects(installPreset({ root, source }), /Invalid packaged/)
  assert.equal(existsSync(root), false)
})

test('file symlink resource fails without copying its contents', async (t) => {
  const temp = await temporary(t)
  const source = path.join(temp, 'source'); await mkdir(source)
  const external = path.join(temp, 'external.yml'); await writeFile(external, 'private')
  if (!await makeLink(t, external, path.join(source, 'agent.cordis.yml'), false)) return
  await writeFile(path.join(source, 'preset.yml'), 'name: Test')
  await assert.rejects(installPreset({ root: path.join(temp, 'roster'), source }), /Invalid packaged/)
})

test('concurrent installers admit exactly one winner without merging or overwrite', async (t) => {
  const temp = await temporary(t)
  const root = path.join(temp, 'roster')
  const results = await Promise.allSettled([installPreset({ root }), installPreset({ root })])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
  assert.deepEqual((await readdir(path.join(root, 'paper-director'))).sort(), [...PRESET_FILES].sort())
})

test('actual CLI dry-run and installation run only against a temporary root', async (t) => {
  const temp = await temporary(t)
  const script = fileURLToPath(new URL('../scripts/install-preset.mjs', import.meta.url))
  const root = path.join(temp, 'cli-roster')
  for (const args of [['--root', root, '--dry-run'], ['--root', root]]) {
    const result = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' })
    if (result.error) throw result.error
    assert.equal(result.status, 0)
    if (args.includes('--dry-run')) assert.equal(existsSync(root), false)
  }
  const refused = spawnSync(process.execPath, [script, '--root', root], { stdio: 'inherit' })
  assert.equal(refused.status, 1)
})
