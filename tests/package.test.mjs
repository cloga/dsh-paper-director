import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { gzipSync, gunzipSync } from 'node:zlib'
import { packAndCheck, readTarball, REQUIRED_FILES, validatePackage } from '../scripts/check-package.mjs'

// These mutation tests exercise the validator, NOT package installation.
async function fixture() {
  const entries = new Map(REQUIRED_FILES.map((name) => [name, Buffer.from('fixture')]))
  for (const name of ['package.json', 'cordis.patch.yml', 'presets/paper-director/agent.cordis.yml', 'presets/paper-director/preset.yml', 'lib/client.js']) {
    entries.set(name, await readFile(new URL(`../${name}`, import.meta.url)))
  }
  return entries
}
function changeManifest(entries, mutate) {
  const manifest = JSON.parse(entries.get('package.json'))
  mutate(manifest)
  entries.set('package.json', Buffer.from(JSON.stringify(manifest)))
}

test('package validator rejects each missing runtime and installation resource', async () => {
  const entries = await fixture()
  validatePackage(entries)
  for (const name of REQUIRED_FILES) {
    const missing = new Map(entries); missing.delete(name)
    assert.throws(() => validatePackage(missing), /Missing package resource/, name)
  }
})

test('package validator rejects private files and dependency/test/build artifacts', async () => {
  for (const name of ['.env', '.env.example', 'src/.env.production', 'src/project.db', 'python/project.sqlite-wal', 'src/private/photo.jpg', 'web/family.mp4', 'web/photo.png', 'web/recording.wav', 'node_modules/dependency/index.js', 'python/.venv/package.py', 'python/__pycache__/worker.pyc', 'tests/example.mjs', 'docs/.artifacts/report.json', 'web/coverage/report.json', 'web/.deps/x.js', 'docs/key.pem', 'docs/secrets/value.txt', '../escape.js', '/absolute.js', 'web\\escape.js']) {
    const entries = await fixture(); entries.set(name, Buffer.from('must not ship'))
    assert.throws(() => validatePackage(entries), /Forbidden|Unexpected|Unsafe/, name)
  }
})

test('resource-name drift, export mistakes and installation lifecycle scripts fail', async () => {
  const mutations = [
    (m) => { m.name = 'wrong-name' },
    (m) => { m.exports['./tools'] = './absent.js' },
    (m) => { m.dsh.bundle.patch = './missing.yml' },
    (m) => { m.dsh.host = './index.js' },
    (m) => { m.dsh.client.external.push('react-dom') },
    (m) => { m.dsh.client.inject = ['slots'] },
    (m) => { m.dsh.client.bundleShell = true },
    ...['preinstall', 'install', 'postinstall', 'prepare'].map((name) => (m) => { m.scripts[name] = 'node scripts/install-preset.mjs' }),
  ]
  for (const mutation of mutations) {
    const entries = await fixture(); changeManifest(entries, mutation)
    assert.throws(() => validatePackage(entries))
  }
  for (const name of ['cordis.patch.yml', 'presets/paper-director/agent.cordis.yml']) {
    const entries = await fixture(); entries.set(name, Buffer.from('name: renamed-plugin'))
    assert.throws(() => validatePackage(entries))
  }
})

test('ModuleLoader factory really executes and accepts only the runtime React seed', async () => {
  const entries = await fixture()
  validatePackage(entries)
  for (const client of [
    'window.__ModuleLoader__.load({id:"wrong",factory:()=>({inject:["slots"],apply(){}})})',
    'window.__ModuleLoader__.load({id:"dsh-paper-director",factory:(require)=>{require("react"); require("fs");return {inject:["slots"],apply(){}}}})',
    'window.__ModuleLoader__.load({id:"dsh-paper-director",factory:(require)=>{require("react"); throw Error("broken")}})',
    'var React = require("react"); // no registration',
    `${entries.get('lib/client.js')}\n// bundleShell`,
    `${entries.get('lib/client.js')}\n${entries.get('lib/client.js')}`,
  ]) {
    const changed = new Map(entries); changed.set('lib/client.js', Buffer.from(client))
    assert.throws(() => validatePackage(changed))
  }
})

function tarFixture(name, type = '0') {
  const header = Buffer.alloc(512)
  header.write(name); header.write('00000000001\0', 124); header.fill(32, 148, 156); header.write(type, 156)
  let checksum = 0; for (const byte of header) checksum += byte
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148)
  return gzipSync(Buffer.concat([header, Buffer.from('x'), Buffer.alloc(511), Buffer.alloc(1024)]))
}

test('tar reader rejects traversal, links, corrupt checksums and non-package entries', () => {
  assert.equal(readTarball(tarFixture('package/a.txt')).get('a.txt').toString(), 'x')
  for (const name of ['package/../evil', 'package//evil', 'outside/file', 'package/C:/evil', 'package/x\\evil']) assert.throws(() => readTarball(tarFixture(name)))
  for (const type of ['1', '2', '5', 'x', 'g']) assert.throws(() => readTarball(tarFixture('package/a.txt', type)), /Non-regular/)
  const corrupt = gunzipSync(tarFixture('package/a.txt')); corrupt[0] ^= 1
  assert.throws(() => readTarball(gzipSync(corrupt)), /checksum/)
  const one = gunzipSync(tarFixture('package/a.txt')).subarray(0, 1024)
  assert.throws(() => readTarball(gzipSync(Buffer.concat([one, one, Buffer.alloc(1024)]))), /Duplicate/)
  assert.throws(() => readTarball(gzipSync(Buffer.alloc(100))), /Missing tar end/)
  assert.throws(() => readTarball(Buffer.from('not gzip')))
})

test('real npm pack --ignore-scripts contains the deployable resources and no private artifacts', async (t) => {
  const sdkRoot = process.env.DSH_ADAPTER_SDK_ROOT
  const result = await packAndCheck({ inspect: async (entries) => {
    await t.test('the actual tarball installer copies its packaged resources into a temporary user root', async () => {
      const temporary = await mkdtemp(path.join(tmpdir(), 'paper-packed-installer-'))
      try {
        const extracted = path.join(temporary, 'package')
        for (const [name, content] of entries) { await mkdir(path.dirname(path.join(extracted, name)), { recursive: true }); await writeFile(path.join(extracted, name), content) }
        const { installPreset } = await import(pathToFileURL(path.join(extracted, 'scripts/install-preset.mjs')).href)
        const result = await installPreset({ root: path.join(temporary, 'user-roster') })
        for (const name of ['agent.cordis.yml', 'preset.yml']) assert.deepEqual(await readFile(path.join(result.target, name)), entries.get(`presets/paper-director/${name}`))
      } finally { await rm(temporary, { recursive: true, force: true }) }
    })
    await t.test('actual DSH bundle resolver parses packed resources in an isolated profile (NOT pnpm install or Host mount)', {
      skip: sdkRoot ? false : 'Set DSH_ADAPTER_SDK_ROOT to test the actual DSH 0.1.2-rc.1 bundle resolver; no SDK was installed by this suite',
    }, async () => {
      for (const [name, version] of [['dsh', '0.1.2-rc.1'], ['cordis', '4.0.2'], ['schemastery', '3.18.2'], ['../react', '19.2.8']]) {
        const manifest = JSON.parse(await readFile(path.join(sdkRoot, name, 'package.json'), 'utf8'))
        assert.equal(manifest.version, version, `This acceptance probe targets ${name}@${version}; do not silently substitute SDK versions`)
      }
      const { initProfile, resolveProfileDir, resolveBundleDir, loadProfile, composeEntries } = await import(pathToFileURL(path.join(sdkRoot, 'dsh-app-boot/lib/index.js')).href)
      const temporary = await mkdtemp(path.join(tmpdir(), 'paper-profile-resolution-'))
      try {
        const dir = resolveProfileDir('paper-package-test', temporary)
        initProfile(dir, ['dsh-paper-director'])
        const root = path.join(dir, 'node_modules', 'dsh-paper-director')
        for (const [name, content] of entries) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content) }
        const profileRequire = createRequire(path.join(dir, 'package.json'))
        for (const [specifier, relative] of [['dsh-paper-director', 'index.js'], ['dsh-paper-director/tools', 'src/tools.js'], ['dsh-paper-director/client', 'lib/client.js'], ['dsh-paper-director/core', 'src/core/service.js']]) {
          assert.equal(await realpath(profileRequire.resolve(specifier)), await realpath(path.join(root, relative)))
        }
        const anchor = path.join(sdkRoot, 'dsh/package.json')
        assert.equal(await realpath(resolveBundleDir('dsh', 'dsh-paper-director', anchor, dir)), await realpath(root))
        const profile = loadProfile('dsh', 'paper-package-test', anchor, temporary)
        assert.equal(profile.layers.length, 1)
        assert.equal(profile.layers[0].packageName, 'dsh-paper-director')
        assert.equal(profile.layers[0].patchPath, path.join(root, 'cordis.patch.yml'))
        const rows = composeEntries(profile.layers.map((layer) => layer.patches))
        assert.equal(rows.length, 1)
        assert.equal(rows[0].name, 'dsh-paper-director')
        assert.equal(rows[0].config.allowCloudTts, false)
        const settings = await readFile(path.join(dir, 'pnpm-workspace.yaml'), 'utf8')
        assert.match(settings, /^autoInstallPeers: false$/m)
        assert.match(settings, /^nodeLinker: hoisted$/m)
        // Merely parsing an expression cannot initialize the media core or create its data directory.
        assert.deepEqual(profile.patches, [])
      } finally { await rm(temporary, { recursive: true, force: true }) }
    })
  } })
  assert.equal(result.name, 'dsh-paper-director')
  assert.ok(result.files >= REQUIRED_FILES.length)
})
