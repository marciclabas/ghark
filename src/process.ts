import { spawn, spawnSync } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'

type RunOptions = {
  allowFailure?: boolean
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  quiet?: boolean
}

type AsyncRunOptions = RunOptions & {
  onStdout?: (chunk: string) => void
  signal?: AbortSignal
}

export class CommandCancelledError extends Error {
  constructor(command: string) {
    super(`${command} was cancelled`)
    this.name = 'CommandCancelledError'
  }
}

export function commandExists(command: string): boolean {
  return spawnSync('sh', ['-c', `command -v "$1" >/dev/null 2>&1`, 'sh', command]).status === 0
}

export function runCapture(command: string, args: string[], options: RunOptions = {}): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    input: options.input,
    stdio: ['pipe', 'pipe', options.quiet ? 'pipe' : 'inherit']
  })
  if (result.error) throw result.error
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.quiet ? result.stderr?.trim() : ''
    throw new Error(`${command} exited with status ${result.status}${detail ? `: ${detail}` : ''}`)
  }
  return result.stdout ?? ''
}

export function run(command: string, args: string[], options: RunOptions = {}): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    input: options.input,
    stdio: options.quiet ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit']
  })
  if (result.error) throw result.error
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.quiet ? result.stderr?.trim() : ''
    throw new Error(`${command} exited with status ${result.status}${detail ? `: ${detail}` : ''}`)
  }
}

export async function runStreaming(command: string, args: string[], options: SpawnOptions = {}): Promise<number> {
  const child = spawn(command, args, { stdio: 'inherit', ...options })
  return await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
}

export async function runCaptureAsync(command: string, args: string[], options: AsyncRunOptions = {}): Promise<string> {
  if (options.signal?.aborted) throw new CommandCancelledError(command)
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  let cancelled = false
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
    options.onStdout?.(chunk)
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
    if (!options.quiet) process.stderr.write(chunk)
  })
  const cancel = () => {
    cancelled = true
    child.kill('SIGINT')
  }
  options.signal?.addEventListener('abort', cancel, { once: true })

  try {
    return await new Promise<string>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => {
        if (cancelled || options.signal?.aborted) {
          reject(new CommandCancelledError(command))
          return
        }
        if (code !== 0 && !options.allowFailure) {
          const detail = options.quiet ? stderr.trim() : ''
          reject(new Error(`${command} exited with status ${code}${detail ? `: ${detail}` : ''}`))
          return
        }
        resolve(stdout)
      })
    })
  } finally {
    options.signal?.removeEventListener('abort', cancel)
  }
}

export function dockerCompose(root: string, args: string[], options: RunOptions = {}): string {
  const project = process.env.GHARK_COMPOSE_PROJECT ?? 'ghark'
  return runCapture('docker', ['compose', '--project-name', project, '--file', `${root}/compose.yaml`, ...args], {
    cwd: root,
    ...options
  })
}

export async function dockerComposeAsync(root: string, args: string[], options: AsyncRunOptions = {}): Promise<string> {
  const project = process.env.GHARK_COMPOSE_PROJECT ?? 'ghark'
  return await runCaptureAsync('docker', ['compose', '--project-name', project, '--file', `${root}/compose.yaml`, ...args], {
    cwd: root,
    ...options
  })
}

export function privileged(command: string, args: string[]): void {
  if (process.getuid?.() === 0) run(command, args)
  else run('sudo', [command, ...args])
}
