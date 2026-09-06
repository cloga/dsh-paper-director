#!/usr/bin/env node
// Explicit adult action only. This module has no import-time installation side effects.
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rmdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PRESET_ID = 'paper-director'
export const PRESET_FILES = Object.freeze(['agent.cordis.yml', 'preset.yml'])
const sourceDirectory = fileURLToPath(new URL('../presets/paper-director/', import.meta.url))
const help = `Usage: node scripts/install-preset.mjs [--root <user-preset-root>] [--dry-run]
Copies only the packaged paper-director preset into a NEW directory.
--root is the user preset roster root, not DSH_HOME or the final preset directory.
Default: DSH_HOME/.agent-presets, or ~/.dsh/.agent-presets when DSH_HOME is unset
Existing destinations, symbolic links/junctions, and shipped-preset paths are refused.
No package installation, Host change, preset mount, or running DSH change is performed.`

export function parseArguments(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') options.help = true
    else if (argv[i] === '--dry-run' && !options.dryRun) options.dryRun = true
    else if (argv[i] === '--root' && options.root === undefined) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--root requires a directory')
      options.root = argv[++i]
    } else throw new Error(`Unknown or repeated argument: ${argv[i]}`)
  }
  return options
}

async function statOrMissing(target) {
  try { return await lstat(target) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

// Walk every ancestor, not just the leaf: a junction in the middle redirects writes too.
async function checkDirectories(target, create = false) {
  const absolute = path.resolve(target)
  const { root } = path.parse(absolute)
  let current = root
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    let stat = await statOrMissing(current)
    if (!stat && create) { try { await mkdir(current) } catch (error) { if (error.code !== 'EEXIST') throw error }; stat = await lstat(current) }
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error(`Unsafe directory (not a plain directory): ${current}`)
  }
}

function checkUserRoot(root) {
  const parts = root.split(/[\\/]+/).map((part) => part.toLowerCase())
  if (parts.some((part) => ['node_modules', 'agent-presets', '@deepseek-ai', 'presets'].includes(part))) {
    throw new Error('Refusing a package/shipped preset location; select a separate user roster root (.agent-presets)')
  }
  if (root === path.parse(root).root || path.basename(root).toLowerCase() === PRESET_ID) throw new Error('--root must be a user preset roster root, not the filesystem root or final preset directory')
}

export async function installPreset({ root, dryRun = false, env = process.env, home = homedir(), source = sourceDirectory } = {}) {
  if (root !== undefined && (typeof root !== 'string' || !root.trim())) throw new Error('--root requires a nonempty directory')
  if (root === undefined && env.DSH_HOME !== undefined && !env.DSH_HOME.trim()) throw new Error('DSH_HOME is empty; provide --root explicitly')
  const destinationRoot = path.resolve(root ?? path.join(env.DSH_HOME ?? path.join(home, '.dsh'), '.agent-presets'))
  checkUserRoot(destinationRoot)
  await checkDirectories(destinationRoot)
  const target = path.join(destinationRoot, PRESET_ID)
  if (await statOrMissing(target)) throw new Error(`Destination already exists; refusing overwrite: ${target}`)
  await checkDirectories(source)
  const files = []
  for (const name of PRESET_FILES) {
    const filename = path.join(source, name)
    const stat = await lstat(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error(`Invalid packaged preset resource: ${name}`)
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.size > 1024 * 1024 || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error(`Preset resource changed: ${name}`)
      files.push([name, await handle.readFile()])
    } finally { await handle.close() }
  }
  const result = { dryRun, root: destinationRoot, target, files: [...PRESET_FILES] }
  if (dryRun) return result
  await checkDirectories(destinationRoot, true)
  if (path.resolve(await realpath(destinationRoot)).toLowerCase() !== destinationRoot.toLowerCase()) throw new Error('User root resolves to a different location')
  // Non-recursive mkdir arbitrates concurrent installers; never overwrite an existing target.
  await mkdir(target, { mode: 0o700 })
  const copied = []
  try {
    await checkDirectories(target)
    for (const [name, bytes] of files) {
      const handle = await open(path.join(target, name), 'wx', 0o600)
      copied.push(name)
      try { await handle.writeFile(bytes) } finally { await handle.close() }
    }
  } catch (error) {
    // Do not recursively remove unexpected files that another writer might have created.
    for (const name of copied) await unlink(path.join(target, name)).catch(() => {})
    await rmdir(target).catch(() => {})
    throw error
  }
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArguments(process.argv.slice(2))
    if (options.help) console.log(help)
    else {
      const result = await installPreset(options)
      console.log(`${result.dryRun ? 'DRY RUN: would copy' : 'Copied'} ${result.files.join(', ')} to ${result.target}`)
      console.log('No preset was mounted. Verify the active user roster, then validate in an authorized isolated DSH profile.')
    }
  } catch (error) { console.error(`Preset installation refused: ${error.message}`); process.exitCode = 1 }
}
