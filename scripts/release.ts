import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

type CommandResult = {
  status: number
  stdout: string
  stderr: string
}

function command(command: string, args: string[], capture = false): CommandResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  })
  if (result.error) throw result.error
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  }
}

function run(commandName: string, args: string[], capture = false): string {
  const result = command(commandName, args, capture)
  if (result.status !== 0) {
    const detail = capture ? result.stderr.trim() : ''
    throw new Error(`${commandName} exited with status ${result.status}${detail ? `: ${detail}` : ''}`)
  }
  return result.stdout.trim()
}

function parseStableVersion(version: string): [number, number, number] {
  const match = version.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  if (!match?.[1] || !match[2] || !match[3]) throw new Error(`Expected a stable semantic version, received ${version}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function nextVersion(current: string, requested: string): string {
  const [major, minor, patch] = parseStableVersion(current)
  if (requested === 'major') return `${major + 1}.0.0`
  if (requested === 'minor') return `${major}.${minor + 1}.0`
  if (requested === 'patch') return `${major}.${minor}.${patch + 1}`
  parseStableVersion(requested)
  const currentParts = [major, minor, patch]
  const requestedParts = parseStableVersion(requested)
  for (let index = 0; index < currentParts.length; index += 1) {
    const difference = (requestedParts[index] ?? 0) - (currentParts[index] ?? 0)
    if (difference > 0) return requested
    if (difference < 0) break
  }
  throw new Error(`Release version ${requested} must be newer than ${current}`)
}

async function confirmRelease(version: string): Promise<boolean> {
  const terminal = createInterface({ input: stdin, output: stdout })
  try {
    const answer = await terminal.question(`Release ghark v${version} from main? [y/N] `)
    return /^(y|yes)$/i.test(answer.trim())
  } finally {
    terminal.close()
  }
}

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter(argument => !argument.startsWith('--'))
  const flags = new Set(process.argv.slice(2).filter(argument => argument.startsWith('--')))
  const requested = positional[0]
  const unknownFlags = [...flags].filter(flag => !['--yes', '--dry-run'].includes(flag))
  if (!requested || positional.length !== 1 || unknownFlags.length > 0) {
    throw new Error('Usage: npm run release -- <patch|minor|major|VERSION> [--yes] [--dry-run]')
  }

  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { name?: string, version?: string }
  if (manifest.name !== '@marciclabas/ghark' || !manifest.version) throw new Error('package.json must describe the @marciclabas/ghark package')
  const version = nextVersion(manifest.version, requested)
  const tag = `v${version}`

  if (run('git', ['status', '--porcelain'], true)) throw new Error('The worktree must be clean before releasing')
  if (run('git', ['branch', '--show-current'], true) !== 'main') throw new Error('Releases must be created from main')
  const origin = run('git', ['remote', 'get-url', 'origin'], true)
  if (!/(?:github\.com[:/])marciclabas\/ghark(?:\.git)?$/i.test(origin)) throw new Error(`Unexpected origin remote: ${origin}`)

  run('git', ['fetch', 'origin', 'main'])
  if (run('git', ['rev-parse', 'HEAD'], true) !== run('git', ['rev-parse', 'origin/main'], true)) {
    throw new Error('Local main must exactly match origin/main before releasing')
  }
  if (command('git', ['rev-parse', '--quiet', '--verify', `refs/tags/${tag}`], true).status === 0) {
    throw new Error(`Local tag ${tag} already exists`)
  }
  const remoteTag = command('git', ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`], true)
  if (remoteTag.status === 0) throw new Error(`Remote tag ${tag} already exists`)
  if (remoteTag.status !== 2) throw new Error(`Could not check remote tag ${tag}: ${remoteTag.stderr.trim()}`)

  if (run('gh', ['api', 'user', '--jq', '.login'], true) !== 'marciclabas') {
    throw new Error('The active GitHub CLI account must be marciclabas')
  }
  const published = command('npm', ['view', `@marciclabas/ghark@${version}`, 'version'], true)
  if (published.status === 0) throw new Error(`@marciclabas/ghark@${version} is already published`)
  if (!/E404|not found/i.test(published.stderr)) throw new Error(`Could not verify npm version availability: ${published.stderr.trim()}`)

  run('npm', ['run', 'check'])
  if (flags.has('--dry-run')) {
    console.log(`Dry run passed. ghark ${manifest.version} would become ${version} and create ${tag}.`)
    return
  }
  if (!flags.has('--yes') && !await confirmRelease(version)) throw new Error('Release cancelled')

  let changed = false
  try {
    run('npm', ['version', version, '--no-git-tag-version'])
    changed = true
    run('git', ['add', 'package.json', 'package-lock.json'])
    run('git', ['commit', '--message', `Release ${tag}`])
    run('git', ['tag', '--annotate', tag, '--message', `Release ${tag}`])
    run('git', ['push', '--atomic', 'origin', 'main', tag])
    run('gh', ['release', 'create', tag, '--verify-tag', '--generate-notes', '--title', `ghark ${tag}`])
  } catch (error) {
    if (changed) console.error('Release preparation changed local Git state. Inspect it before retrying; no automatic rollback was attempted.')
    throw error
  }
  console.log(`Released ghark ${version}. GitHub Actions will publish it to npm.`)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`release: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
