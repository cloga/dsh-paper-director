import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { readTarball, validatePackage } from '../scripts/check-package.mjs'

// Explicit opt-in: executes the installed CLI/pnpm, but only against an owned
// temporary home, offline tarball/store and blank npm config. No GUI or listener.
const enabled = process.env.DSH_INSTALL_SMOKE === '1'
const sdkRoot = process.env.DSH_ADAPTER_SDK_ROOT
const root = fileURLToPath(new URL('../', import.meta.url))
const url = (filename) => pathToFileURL(filename).href
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function npmCli() {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')]
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    candidates.push(path.join(directory, 'node_modules/npm/bin/npm-cli.js'), path.resolve(directory, '../lib/node_modules/npm/bin/npm-cli.js'))
  }
  const found = candidates.find((candidate) => candidate?.endsWith('.js') && existsSync(candidate))
  assert.ok(found, 'Install Node with npm, or invoke through npm with npm_execpath')
  return found
}
function execute(args, options) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', timeout: 120000, ...options })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `Child command failed: ${args[0]}; no version downgrade, mirror or peer-link workaround is permitted`)
}

// No fixture copies/junctions to SDK are created by this test. Every SDK fallback
// below is created by the exact production app-boot healProfilesModuleFallback.
test('ordinary tarball installs offline and really boots through installed DSH profile fallback', {
  skip: enabled ? false : 'Set DSH_INSTALL_SMOKE=1 and DSH_ADAPTER_SDK_ROOT for isolated actual CLI/pnpm/Loader acceptance',
  timeout: 180000,
}, async (t) => {
  assert.ok(sdkRoot, 'DSH_ADAPTER_SDK_ROOT must explicitly name existing node_modules/@deepseek-ai')
  const expected = { dsh: '0.1.2-rc.1', cordis: '4.0.2', schemastery: '3.18.2', 'dsh-tools': '0.1.2-rc.1', 'dsh-llm': '0.1.2-rc.1', 'dsh-session': '0.1.2-rc.1', '../react': '19.2.8' }
  for (const [name, version] of Object.entries(expected)) {
    assert.equal(JSON.parse(await readFile(path.join(sdkRoot, name, 'package.json'), 'utf8')).version, version, `Unsupported SDK ${name}; do not substitute versions`)
  }
  const appBootPath = path.join(sdkRoot, 'dsh-app-boot/lib/index.js')
  const appBoot = await import(url(appBootPath))
  const installAnchor = path.join(sdkRoot, 'dsh/package.json')
  const temporary = await mkdtemp(path.join(tmpdir(), 'paper-installed-sdk-'))
  let ctx, standalone
  try {
    const home = path.join(temporary, 'home')
    const archiveDir = path.join(temporary, 'archive')
    await mkdir(archiveDir)
    const blankConfig = path.join(temporary, 'empty.npmrc')
    await writeFile(blankConfig, '')
    // Do not forward tokens, NODE_OPTIONS, NODE_PATH, cloud settings or the live
    // DSH_HOME. npm/pnpm need only OS/process discovery and this isolated config.
    const env = {}
    const allowed = /^(?:path|systemroot|windir|comspec|pathext|temp|tmp|home|userprofile|localappdata|appdata)$/i
    for (const [key, value] of Object.entries(process.env)) if (allowed.test(key)) env[key] = value
    Object.assign(env, {
      DSH_HOME: home,
      npm_config_userconfig: blankConfig,
      npm_config_globalconfig: path.join(temporary, 'empty-global.npmrc'),
      npm_config_cache: path.join(temporary, 'npm-cache'),
      npm_config_update_notifier: 'false',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_registry: 'https://registry.npmjs.org/',
      CI: 'true',
    })
    await writeFile(env.npm_config_globalconfig, '')
    execute([npmCli(), 'pack', '--ignore-scripts', '--pack-destination', archiveDir], { cwd: root, env })
    const archives = (await readdir(archiveDir)).filter((name) => name.endsWith('.tgz'))
    assert.equal(archives.length, 1)
    const archive = path.join(archiveDir, archives[0])
    const archiveBytes = await readFile(archive)
    const entries = readTarball(archiveBytes)
    const packed = validatePackage(entries)
    const manifest = JSON.parse(entries.get('package.json'))
    t.diagnostic(`Snapshot ${packed.name}@${packed.version}; files=${packed.files}; tarball-sha256=${sha256(archiveBytes)}; manifest-sha256=${sha256(entries.get('package.json'))}`)
    t.diagnostic(`Host index-sha256=${sha256(entries.get('index.js'))}; Core service-sha256=${sha256(entries.get('src/core/service.js'))}`)

    const profileName = 'paper-install-smoke'
    const profileDir = appBoot.resolveProfileDir(profileName, home)
    // Minimal host composition: deliberately no base/web/provider/preset rows.
    // This uses the official initProfile template and tests plugin reconciliation.
    appBoot.initProfile(profileDir, [], 'startup')
    execute([path.join(sdkRoot, 'dsh/lib/bin.js'), 'plugin', '--profile', profileName, 'add', archive, '--ignore-scripts', '--offline', '--store-dir', path.join(temporary, 'pnpm-store')], { cwd: temporary, env })
    const installedManifest = JSON.parse(await readFile(path.join(profileDir, 'package.json'), 'utf8'))
    assert.deepEqual(installedManifest.dsh.profile.bundles, ['dsh-paper-director'])
    assert.deepEqual(Object.keys(installedManifest.dependencies), ['dsh-paper-director'])
    const workspace = await readFile(path.join(profileDir, 'pnpm-workspace.yaml'), 'utf8')
    assert.match(workspace, /^autoInstallPeers: false$/m)
    assert.match(workspace, /^nodeLinker: hoisted$/m)
    const profileRequire = createRequire(path.join(profileDir, 'package.json'))
    const installedEntry = profileRequire.resolve('dsh-paper-director')
    const installedRoot = path.dirname(installedEntry)
    assert.equal(await realpath(installedRoot), installedRoot, 'Tarball must be a real profile package, not source checkout junction')
    for (const [name, bytes] of entries) assert.deepEqual(await readFile(path.join(installedRoot, name)), bytes, `Installed bytes differ: ${name}`)
    for (const peer of Object.keys(manifest.peerDependencies)) {
      assert.equal(existsSync(path.join(profileDir, 'node_modules', peer)), false, `pnpm unexpectedly installed peer ${peer}`)
    }
    // A negative real import proves bare exports resolution alone was insufficient.
    execute(['--input-type=module', '-e', `import assert from 'node:assert/strict'; await assert.rejects(import(${JSON.stringify(url(installedEntry))}), e => e.code === 'ERR_MODULE_NOT_FOUND' && e.message.includes('@deepseek-ai/cordis')); console.log('PASS pre-heal real import rejects missing Cordis peer');`], { cwd: profileDir, env })

    const profile = appBoot.loadProfile('paper-install-smoke', profileName, installAnchor, home)
    await appBoot.healProfilesModuleFallback({ installAnchor, profile, home })
    // This is the actual production fallback, not scripts/link-sdk.mjs.
    const sdkRequire = createRequire(installAnchor)
    const { satisfies } = sdkRequire('semver')
    for (const peer of Object.keys(manifest.peerDependencies)) {
      const fallback = path.join(home, 'profiles/node_modules', peer)
      assert.equal((await lstat(fallback)).isSymbolicLink(), true, `Plain Node fallback must be a link for ${peer}`)
      if (peer === 'react') {
        // The installed SDK closure selects renderer-local React, not root React.
        // Validate the actual packed release's peer range without repairing links.
        // A compatible range does not imply browser behavior has been tested.
        const resolvedReact = JSON.parse(await readFile(profileRequire.resolve('react/package.json'), 'utf8')).version
        t.diagnostic(`Official fallback React=${resolvedReact}; plugin requires ${manifest.peerDependencies.react}; SDK root React=19.2.8`)
        await t.test('official fallback React satisfies the packed peer range (browser acceptance separate)', () => {
          assert.ok(satisfies(resolvedReact, manifest.peerDependencies.react), `Official React ${resolvedReact} does not satisfy packed ${manifest.peerDependencies.react}`)
        })
      } else {
        assert.equal(await realpath(profileRequire.resolve(peer)), await realpath(sdkRequire.resolve(peer)), `Peer ${peer} must resolve to current SDK, not a duplicate`)
      }
      assert.equal(existsSync(path.join(profileDir, 'node_modules', peer)), false, 'Shared parent fallback must not be mistaken for pnpm-managed profile peers')
    }
    for (const [label, React] of [['production-fallback', profileRequire('react')], ['sdk-root-dev', sdkRequire('react')]]) {
      await t.test(`packed ModuleLoader factory and anchor use actual ${label} React ${React.version}`, () => {
        let factory, renderLink
        const realm = vm.createContext({ window: { __ModuleLoader__: { load(record) {
          assert.equal(record.id, 'dsh-paper-director')
          assert.equal(factory, undefined)
          factory = record.factory
        } } } }, { codeGeneration: { strings: false, wasm: false } })
        vm.runInContext(entries.get('lib/client.js').toString('utf8'), realm, { timeout: 1000 })
        const plugin = factory((name) => { assert.equal(name, 'react'); return React })
        plugin.apply({ slots: {
          inject(name, callback) { assert.equal(name, 'sidebar.footer.action'); callback() },
          register(options, component) { assert.equal(options.id, 'paper-director-link'); renderLink = component; return () => {} },
        } })
        for (const wide of [true, false]) {
          const element = renderLink({ wide })
          assert.ok(React.isValidElement(element))
          assert.equal(element.type, 'a')
          assert.equal(element.props.href, '/paper-director/')
          assert.equal(element.props.children[1], wide ? '纸上小导演' : null)
          assert.ok(React.isValidElement(element.props.children[0]))
        }
      })
    }
    const configPath = path.join(profileDir, 'cordis.yml')
    await writeFile(configPath, '[]\n')
    const dataDir = path.join(temporary, 'host-data')
    const patches = [...profile.layers.flatMap((layer) => layer.patches), { id: 'paper-director', config: { dataDir } }]
    ctx = await appBoot.boot('paper-install-smoke', configPath, patches)
    const service = ctx.get('paperDirector')
    assert.ok(service, 'Real appBoot must activate the packed Host Service')
    assert.equal(service.core.initialized, true)
    assert.ok(ctx.loader.internal, 'Native production Loader helper is required; no expose-internals fallback')
    const sdkCordis = await import(url(sdkRequire.resolve('@deepseek-ai/cordis')))
    const profileCordis = await ctx.loader.internal.import('@deepseek-ai/cordis', url(installedEntry), {})
    assert.equal(profileCordis.Service, sdkCordis.Service, 'Host and plugin must share the SAME Cordis Service constructor')
    const tools = await ctx.loader.internal.import('dsh-paper-director/tools', url(configPath), {})
    assert.equal(typeof tools.apply, 'function', 'Tools export must really evaluate with DSH tools peers')
    const coreModule = await ctx.loader.internal.import('dsh-paper-director/core', url(configPath), {})
    assert.equal(typeof coreModule.PaperDirectorCore, 'function')
    const hostProject = await service.dispatch('project.create', { title: '安装验证匿名项目' })
    assert.equal((await service.dispatch('project.get', {}, { projectId: hostProject.id })).title, '安装验证匿名项目')
    standalone = await new coreModule.PaperDirectorCore({ dataDir: path.join(temporary, 'standalone-data') }).init()
    const standaloneProject = await standalone.dispatch('project.create', { title: '独立Core匿名项目' })
    assert.notEqual(standaloneProject.id, hostProject.id)
    await standalone.close()
    assert.equal(standalone.closed, true)
    standalone = undefined
    await ctx.fiber.dispose()
    assert.equal(ctx.get('paperDirector'), undefined)
    assert.equal(service.core.closed, true)
    ctx = undefined
    // Re-open the SAME host database: disposal must release its actual SQLite lease.
    standalone = await new coreModule.PaperDirectorCore({ dataDir }).init()
    assert.equal((await standalone.dispatch('project.get', {}, { projectId: hostProject.id })).title, '安装验证匿名项目')
    await standalone.close()
    standalone = undefined
    t.diagnostic(`PASS actual CLI offline tarball installation, pre-heal negative import, official fallback inspected for ${Object.keys(manifest.peerDependencies).length} peers (React range checked separately), native Loader Host/tools/core evaluation, shared Cordis identity, project creation, unload and SQLite re-open`)
    t.diagnostic(`SDK app-boot-sha256=${sha256(await readFile(appBootPath))}; Node=${process.version}; no GUI, HTTP listener, model, credentials, registry download or user preset mount`)
  } finally {
    await standalone?.close()
    await ctx?.fiber.dispose()
    await rm(temporary, { recursive: true, force: true })
  }
})
