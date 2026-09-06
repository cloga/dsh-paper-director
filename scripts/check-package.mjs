#!/usr/bin/env node
// Build and inspect the real npm artifact, without installing dependencies or running scripts.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import vm from 'node:vm'

export const REQUIRED_FILES = Object.freeze([
  'package.json', 'index.js', 'src/tools.js', 'src/http.js', 'src/core/service.js',
  'src/core/model.js', 'src/core/store.js', 'src/core/timeline.js', 'src/core/worker.js',
  'lib/client.js', 'cordis.patch.yml', 'presets/paper-director/agent.cordis.yml',
  'presets/paper-director/preset.yml', 'web/index.html', 'web/studio.js', 'web/studio.css',
  'python/worker.py', 'python/paper_director/__init__.py', 'python/paper_director/alignment.py',
  'python/paper_director/fonts.py', 'python/paper_director/media.py',
  'python/paper_director/renderer.py', 'python/paper_director/safety.py',
  'requirements.txt', 'requirements-asr.txt', 'scripts/install-preset.mjs', 'docs/install.md', 'README.md', 'LICENSE',
])
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const forbiddenParts = /^(?:node_modules|\.venv|venv|__pycache__|\.git|\.github|tests?|\.deps|\.artifacts|artifacts|coverage|\.test-output|\.paper-director|projects|private|media|recordings|uploads|credentials|secrets)$/i
const forbiddenFile = /(?:^\.env(?:\.|$)|\.(?:db(?:-(?:shm|wal))?|sqlite[^.]*|pyc|pyo|log|tgz|zip|pem|key|p12|mp4|m4v|mov|avi|mkv|webm|mp3|m4a|aac|wav|flac|ogg|opus|png|jpe?g|webp|gif|bmp|tiff?|heic|heif|dng|raw)$)/i

function safeName(name) {
  assert.equal(typeof name, 'string', 'Archive entry must have a name')
  assert.ok(name.startsWith('package/'), `Archive entry is outside package/: ${name}`)
  const relative = name.slice('package/'.length)
  assert.ok(relative && !relative.includes('\\') && !relative.includes(':') && !relative.startsWith('/'), `Unsafe archive name: ${name}`)
  assert.ok(relative.split('/').every((part) => part && part !== '.' && part !== '..'), `Unsafe archive path: ${name}`)
  return relative
}

// npm's portable tar output consists of ordinary files; links and metadata extensions
// are deliberately rejected rather than extracted or trusted. Nothing is written from tar.
export function readTarball(compressed) {
  const tar = gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 })
  const entries = new Map()
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      assert.ok(tar.subarray(offset).every((byte) => byte === 0), 'Unexpected data after tar end marker')
      return entries
    }
    const stringAt = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '')
    const sizeText = stringAt(124, 12).trim()
    assert.match(sizeText, /^[0-7]+$/, 'Invalid tar file size')
    const size = Number.parseInt(sizeText, 8)
    let checksum = 0
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]
    assert.equal(Number.parseInt(stringAt(148, 8).trim(), 8), checksum, 'Invalid tar header checksum')
    const prefix = stringAt(345, 155)
    const rawName = `${prefix ? `${prefix}/` : ''}${stringAt(0, 100)}`
    const name = safeName(rawName)
    assert.ok(header[156] === 0 || header[156] === 48, `Non-regular archive entry rejected: ${name}`)
    assert.ok(!entries.has(name), `Duplicate archive entry: ${name}`)
    assert.ok(offset + 512 + size <= tar.length, `Truncated archive entry: ${name}`)
    entries.set(name, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error('Missing tar end marker')
}

export function validatePackage(entries) {
  for (const name of entries.keys()) {
    safeName(`package/${name}`)
    assert.ok(!name.split('/').some((part) => forbiddenParts.test(part) || forbiddenFile.test(part)), `Forbidden package content: ${name}`)
    assert.ok(/^(?:(?:package\.json|index\.js|cordis\.patch\.yml|requirements(?:-asr)?\.txt|README\.md|LICENSE)$|src\/|lib\/client\.js$|web\/|python\/|presets\/paper-director\/|scripts\/(?:install-preset|check-package)\.mjs$|docs\/)/.test(name), `Unexpected package content: ${name}`)
  }
  for (const name of entries.keys()) {
    assert.ok(!name.startsWith('presets/') || ['presets/paper-director/agent.cordis.yml', 'presets/paper-director/preset.yml'].includes(name), `Unexpected preset resource: ${name}`)
  }
  for (const filename of REQUIRED_FILES) assert.ok(entries.has(filename), `Missing package resource: ${filename}`)
  const text = (name) => entries.get(name).toString('utf8')
  const manifest = JSON.parse(text('package.json'))
  assert.equal(manifest.name, 'dsh-paper-director')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, 'index.js')
  assert.deepEqual(manifest.exports, { '.': './index.js', './tools': './src/tools.js', './core': './src/core/service.js', './client': './lib/client.js', './package.json': './package.json' })
  for (const resource of Object.values(manifest.exports)) assert.ok(entries.has(resource.slice(2)), `Export missing: ${resource}`)
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.deepEqual(manifest.dsh?.client?.inject, ['@deepseek-ai/dsh-client-ui-sidebar'])
  assert.deepEqual(manifest.dsh?.client?.external, ['react'])
  assert.ok(!Object.hasOwn(manifest.dsh, 'host'), 'No invented dsh.host shortcut')
  assert.ok(!/bundleShell/i.test(JSON.stringify(manifest.dsh)), 'Client must not bundle the DSH shell')
  for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) assert.ok(!manifest.scripts?.[name], `Automatic lifecycle script forbidden: ${name}`)
  assert.match(text('cordis.patch.yml'), /^\s+name: dsh-paper-director\s*$/m)
  assert.doesNotMatch(text('cordis.patch.yml'), /name:\s*['"]?dsh-paper-director\/tools/)
  assert.match(text('presets/paper-director/agent.cordis.yml'), /^\s+name: dsh-paper-director\/tools\s*$/m)
  assert.match(text('presets/paper-director/preset.yml'), /^name:\s*\S/m)
  assert.match(text('presets/paper-director/preset.yml'), /^description:\s*\S/m)
  const client = text('lib/client.js')
  assert.ok(Buffer.byteLength(client) < 32 * 1024, 'Client unexpectedly large; do not ship a bundled shell')
  assert.doesNotMatch(client, /bundleShell|react-dom|createRoot|import\s*\(|\beval\s*\(/i)
  assert.deepEqual([...client.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]), ['react'])
  let loads = 0
  const required = []
  const realm = vm.createContext({ window: { __ModuleLoader__: { load(registration) {
    loads++
    assert.equal(registration.id, manifest.name)
    assert.equal(typeof registration.factory, 'function')
    const plugin = registration.factory((id) => { required.push(id); assert.equal(id, 'react'); return {} })
    assert.deepEqual(Array.from(plugin.inject), ['slots'])
    assert.equal(typeof plugin.apply, 'function')
  } } } }, { codeGeneration: { strings: false, wasm: false } })
  vm.runInContext(client, realm, { timeout: 1000 })
  assert.equal(loads, 1, 'Exactly one ModuleLoader registration required')
  assert.deepEqual(required, ['react'])
  return { name: manifest.name, version: manifest.version, files: entries.size }
}

function npmCli() {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')]
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const name of ['npm', 'npm.cmd']) {
      const filename = path.join(directory, name)
      if (!existsSync(filename)) continue
      const real = realpathSync(filename)
      if (real.endsWith('.js')) candidates.push(real)
      candidates.push(path.join(path.dirname(real), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(real), '../lib/node_modules/npm/bin/npm-cli.js'))
    }
  }
  const found = candidates.find((candidate) => candidate && candidate.endsWith('.js') && existsSync(candidate))
  assert.ok(found, 'Cannot locate npm-cli.js; run this check through npm run check or install Node with npm')
  return found
}

export async function packAndCheck({ root = projectRoot, inspect } = {}) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'paper-package-'))
  try {
    const child = spawnSync(process.execPath, [npmCli(), 'pack', '--ignore-scripts', '--pack-destination', temporary], {
      cwd: root, stdio: 'inherit', env: { ...process.env, npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' },
    })
    if (child.error) throw child.error
    assert.equal(child.status, 0, 'npm pack --ignore-scripts failed')
    const archives = (await readdir(temporary)).filter((name) => name.endsWith('.tgz'))
    assert.equal(archives.length, 1, 'Expected exactly one npm tarball')
    const entries = readTarball(await readFile(path.join(temporary, archives[0])))
    const result = { ...validatePackage(entries), archive: archives[0] }
    if (inspect) await inspect(entries)
    return result
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 2, 'Usage: node scripts/check-package.mjs')
    const result = await packAndCheck()
    console.log(`PASS: ${result.archive}: ${result.files} regular files; resources, exports, privacy exclusions and React-only ModuleLoader checked.`)
    console.log('This is artifact verification, not an installed DSH profile or live browser acceptance test.')
  } catch (error) { console.error(`Package check failed: ${error.message}`); process.exitCode = 1 }
}
