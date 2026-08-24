import { existsSync, readFileSync } from 'node:fs'
import { defaults, services } from './constants.js'
import type { Service } from './constants.js'
import { parseEnv } from './env.js'
import { redact } from './env.js'
import { writeJson } from './files.js'
import { withOperationLock } from './lock.js'
import { deploymentFiles } from './paths.js'
import { dockerCompose, dockerComposeAsync } from './process.js'
import { resticOptionsFromEnvironment } from './restic.js'
import { reconcileUnlocked } from './reconcile.js'
import type { BackupState } from './types.js'
import { timerStatus } from './systemd.js'

function runningServices(root: string): Service[] {
  const output = dockerCompose(root, ['ps', '--services', '--filter', 'status=running'], { quiet: true })
  const running = new Set(output.trim().split(/\s+/))
  return services.filter(service => running.has(service))
}

type ResticRunOptions = {
  onOutput?: (line: string) => void
  signal?: AbortSignal
}

async function runRestic(root: string, values: Record<string, string>, args: string[], options: ResticRunOptions = {}): Promise<string> {
  let pending = ''
  return await dockerComposeAsync(root, ['run', '--rm', 'restic', ...resticOptionsFromEnvironment(values), ...args], {
    quiet: true,
    ...(options.signal ? { signal: options.signal } : {}),
    onStdout: chunk => {
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) options.onOutput?.(line)
    }
  })
}

export class BackupCancelledError extends Error {
  constructor() {
    super('Backup cancelled by operator')
    this.name = 'BackupCancelledError'
  }
}

export type BackupDependencies = {
  runningServices: (root: string) => Service[]
  compose: typeof dockerCompose
  restic: typeof runRestic
  reconcile: typeof reconcileUnlocked
  now: () => number
  progress: (message: string) => void
  signal?: AbortSignal
}

const defaultDependencies: BackupDependencies = {
  runningServices,
  compose: dockerCompose,
  restic: runRestic,
  reconcile: reconcileUnlocked,
  now: Date.now,
  progress: message => console.log(message)
}

function sanitizedError(error: unknown, values: Record<string, string>): string {
  const secretKeys = [
    'ADMIN_PASSWORD', 'FORGEJO_SECRET_KEY', 'FORGEJO_INTERNAL_TOKEN', 'FORGEJO_TOKEN',
    'BETTER_AUTH_SECRET', 'ENCRYPTION_SECRET', 'GITHUB_TOKEN', 'RESTIC_PASSWORD',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'
  ]
  const message = error instanceof Error ? error.message : String(error)
  return redact(message, secretKeys.flatMap(key => values[key] ? [values[key]] : []))
}

function nextSubset(files: ReturnType<typeof deploymentFiles>): number {
  try {
    const current = JSON.parse(readFileSync(files.verifyState, 'utf8')) as { subset?: number }
    return ((current.subset ?? 0) % 7) + 1
  } catch {
    return 1
  }
}

export async function backup(root: string): Promise<void> {
  const files = deploymentFiles(root)
  const controller = new AbortController()
  const cancel = () => {
    if (controller.signal.aborted) {
      console.log('Cancellation is already in progress; waiting for service recovery…')
      return
    }
    console.log('\nCancellation requested; stopping the active step and restoring services…')
    controller.abort()
  }
  process.on('SIGINT', cancel)
  try {
    await withOperationLock(files.lock, 'backup', async () => {
      await backupUnlocked(root, { signal: controller.signal })
    })
  } finally {
    process.removeListener('SIGINT', cancel)
  }
}

export function backupStatus(root: string): void {
  const files = deploymentFiles(root)
  if (!existsSync(files.manifest)) throw new Error(`No ghark deployment found at ${root}`)

  console.log('Automatic backup schedule:')
  const timer = timerStatus()
  if (timer.installed) console.log(timer.details || 'Installed; systemd returned no status details.')
  else console.log('Not installed. Run ghark backup install to enable it.')

  console.log('\nLatest backup:')
  if (!existsSync(files.backupState)) {
    console.log('None recorded. Run ghark backup start to create one.')
    return
  }
  const state = JSON.parse(readFileSync(files.backupState, 'utf8')) as BackupState
  const health = state.degraded ? 'DEGRADED' : state.success ? 'healthy' : 'FAILED'
  console.log(`Status: ${health}`)
  console.log(`Completed: ${state.completedAt ?? 'unknown'}`)
  if (state.durationSeconds !== undefined) console.log(`Duration: ${state.durationSeconds}s`)
  if (state.snapshotId) console.log(`Snapshot: ${state.snapshotId}`)
  if (state.filesProcessed !== undefined) console.log(`Files processed: ${state.filesProcessed}`)
  if (state.bytesProcessed !== undefined) console.log(`Bytes processed: ${state.bytesProcessed}`)
  if (state.verificationSubset !== undefined) console.log(`Verified data subset: ${state.verificationSubset}/7`)
  if (state.reconciliationError) console.log(`Reconciliation: ${state.reconciliationError}`)
  if (state.error) console.log(`Error: ${state.error}`)
}

export async function backupUnlocked(root: string, overrides: Partial<BackupDependencies> = {}): Promise<void> {
    const dependencies = { ...defaultDependencies, ...overrides }
    const files = deploymentFiles(root)
    const started = dependencies.now()
    const values = parseEnv(readFileSync(files.env, 'utf8'))
    const previouslyRunning = dependencies.runningServices(root)
    let snapshotId: string | undefined
    let filesProcessed: number | undefined
    let bytesProcessed: number | undefined
    let subset: number | undefined
    let lifecycleFailure: unknown
    let reconciliationFailure: unknown

    const throwIfCancelled = () => {
      if (dependencies.signal?.aborted) throw new BackupCancelledError()
    }

    dependencies.progress('Inspecting running services…')
    throwIfCancelled()

    if (previouslyRunning.includes('gitea-mirror')) {
      try {
        if (!previouslyRunning.includes('forgejo')) throw new Error('Forgejo is not running; online reconciliation could not start')
        dependencies.progress('Reconciling mirrors and release assets…')
        await dependencies.reconcile(root, dependencies.signal ? { signal: dependencies.signal } : {})
      } catch (error) {
        if (dependencies.signal?.aborted) lifecycleFailure = new BackupCancelledError()
        else reconciliationFailure = error
      }
    }

    try {
      if (lifecycleFailure) throw lifecycleFailure
      throwIfCancelled()
      dependencies.progress('Pausing services for a consistent snapshot…')
      if (previouslyRunning.includes('gitea-mirror')) dependencies.compose(root, ['stop', '--timeout', '60', 'gitea-mirror'])
      throwIfCancelled()
      if (previouslyRunning.includes('forgejo')) dependencies.compose(root, ['stop', '--timeout', '60', 'forgejo'])

      throwIfCancelled()
      dependencies.progress('Creating encrypted snapshot… (Ctrl+C to cancel)')
      let lastPercent = -10
      const output = await dependencies.restic(root, values, [
        'backup', '--json',
        '/source/.env', '/source/deployment.json', '/source/compose.yaml',
        '/source/.cli/package.json', '/source/.cli/package-lock.json', '/source/data'
      ], {
        ...(dependencies.signal ? { signal: dependencies.signal } : {}),
        onOutput: line => {
          try {
            const event = JSON.parse(line) as { message_type?: string, percent_done?: number }
            const percent = Math.floor((event.percent_done ?? 0) * 100)
            if (event.message_type === 'status' && percent >= lastPercent + 10) {
              lastPercent = percent
              dependencies.progress(`Snapshot upload: ${percent}%`)
            }
          } catch {
            // Restic may emit a non-JSON diagnostic line.
          }
        }
      })
      for (const line of output.trim().split('\n').reverse()) {
        try {
          const event = JSON.parse(line) as {
            message_type?: string
            snapshot_id?: string
            total_bytes_processed?: number
            total_files_processed?: number
          }
          if (event.message_type === 'summary') {
            snapshotId = event.snapshot_id
            bytesProcessed = event.total_bytes_processed
            filesProcessed = event.total_files_processed
            break
          }
        } catch {
          // Ignore non-JSON progress lines.
        }
      }
    } catch (error) {
      lifecycleFailure = dependencies.signal?.aborted ? new BackupCancelledError() : error
    } finally {
      if (previouslyRunning.length > 0) dependencies.progress('Restoring previously running services…')
      for (const service of previouslyRunning) {
        try {
          dependencies.compose(root, ['up', '--detach', service])
        } catch (restartError) {
          lifecycleFailure ??= restartError
        }
      }
    }

    if (!lifecycleFailure) {
      try {
        throwIfCancelled()
        dependencies.progress('Applying snapshot retention policy…')
        await dependencies.restic(root, values, [
          'forget', '--prune',
          '--keep-daily', values.KEEP_DAILY ?? String(defaults.keepDaily),
          '--keep-weekly', values.KEEP_WEEKLY ?? String(defaults.keepWeekly),
          '--keep-monthly', values.KEEP_MONTHLY ?? String(defaults.keepMonthly)
        ], dependencies.signal ? { signal: dependencies.signal } : {})
        dependencies.progress('Checking repository structure…')
        await dependencies.restic(root, values, ['check'], dependencies.signal ? { signal: dependencies.signal } : {})
        subset = nextSubset(files)
        dependencies.progress(`Verifying stored data subset ${subset}/7…`)
        await dependencies.restic(root, values, ['check', `--read-data-subset=${subset}/7`], dependencies.signal ? { signal: dependencies.signal } : {})
        writeJson(files.verifyState, { subset })
      } catch (error) {
        lifecycleFailure = dependencies.signal?.aborted ? new BackupCancelledError() : error
      }
    }

    const reconciliationError = reconciliationFailure ? sanitizedError(reconciliationFailure, values) : undefined
    const lifecycleError = lifecycleFailure ? sanitizedError(lifecycleFailure, values) : undefined
    const degraded = !lifecycleFailure && reconciliationFailure !== undefined
    const state: BackupState = {
      // Preserve the historical meaning for readers of older state files:
      // success describes the snapshot lifecycle, while degraded describes
      // incomplete online reconciliation.
      success: !lifecycleFailure,
      completedAt: new Date(dependencies.now()).toISOString(),
      durationSeconds: Math.round((dependencies.now() - started) / 1000),
      ...(snapshotId ? { snapshotId } : {}),
      ...(filesProcessed !== undefined ? { filesProcessed } : {}),
      ...(bytesProcessed !== undefined ? { bytesProcessed } : {}),
      ...(subset ? { verificationSubset: subset } : {}),
      ...(degraded ? { degraded: true } : {}),
      ...(reconciliationError ? { reconciliationError } : {}),
      ...(lifecycleError ? { error: lifecycleError } : {})
    }
    writeJson(files.backupState, state)
    if (dependencies.signal?.aborted) throw new BackupCancelledError()
    if (lifecycleFailure) throw new Error(lifecycleError)
    if (reconciliationFailure) throw new Error(reconciliationError)
    console.log(`Backup complete${snapshotId ? `: ${snapshotId}` : ''}`)
}
