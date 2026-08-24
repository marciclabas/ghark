import { createServer } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { commandExists, runCapture } from './process.js'

export function assertPrerequisites(): void {
  const missing = ['docker', 'npm', 'systemctl'].filter(command => !commandExists(command))
  if (missing.length > 0) throw new Error(`Missing prerequisites: ${missing.join(', ')}`)
  runCapture('docker', ['compose', 'version'], { quiet: true })
  runCapture('docker', ['info'], { quiet: true })
}

type ComposeProject = {
  Name?: string
  ConfigFiles?: string
}

export function findOtherGharkProject(output: string, root: string): string | undefined {
  const projects = JSON.parse(output || '[]') as ComposeProject[]
  const expected = resolve(root, 'compose.yaml')
  return projects.find(project => {
    if (project.Name !== 'ghark') return false
    const files = (project.ConfigFiles ?? '').split(',').map(file => resolve(file.trim()))
    return !files.includes(expected)
  })?.ConfigFiles
}

export function assertNoOtherInstance(root: string): void {
  const projects = runCapture('docker', ['compose', 'ls', '--all', '--format', 'json'], { quiet: true })
  const otherConfig = findOtherGharkProject(projects, root)
  if (otherConfig) throw new Error(`Another ghark Compose project already exists (${otherConfig})`)

  const unit = '/etc/systemd/system/ghark-backup.service'
  if (existsSync(unit) && !readFileSync(unit, 'utf8').includes(root)) {
    throw new Error(`Another ghark systemd service already exists (${unit})`)
  }
}

export async function portAvailable(port: number): Promise<boolean> {
  return await new Promise(resolve => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ host: '127.0.0.1', port }, () => server.close(() => resolve(true)))
  })
}

export async function assertDistinctAvailablePorts(ports: number[]): Promise<void> {
  if (new Set(ports).size !== ports.length) throw new Error('Each service requires a distinct port')
  for (const port of ports) {
    if (!await portAvailable(port)) throw new Error(`Port ${port} is already in use`)
  }
}
