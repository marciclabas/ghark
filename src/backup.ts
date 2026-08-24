import { readFileSync } from 'node:fs'
import { defaults, services } from './constants.js'
import type { Service } from './constants.js'
import { parseEnv } from './env.js'
import { redact } from './env.js'
import { writeJson } from './files.js'
import { withOperationLock } from './lock.js'
import { deploymentFiles } from './paths.js'
import { dockerCompose } from './process.js'
import { resticOptionsFromEnvironment } from './restic.js'
import { reconcileUnlocked } from './reconcile.js'
import type { BackupState } from './types.js'

function runningServices(root: string): Service[] {
  const output = dockerCompose(root, ['ps', '--services', '--filter', 'status=running'], { quiet: true })
  const running = new Set(output.trim().split(/\s+/))
  return services.filter(service => running.has(service))
}

function runRestic(root: string, values: Record<string, string>, args: string[]): string {
  return dockerCompose(root, ['run', '--rm', 'restic', ...resticOptionsFromEnvironment(values), ...args], { quiet: true })
}

export type BackupDependencies = {
  runningServices: (root: string) => Service[]
  compose: typeof dockerCompose
  restic: typeof runRestic
  reconcile: typeof reconcileUnlocked
  now: () => number
}

const defaultDependencies: BackupDependencies = {
  runningServices,
  compose: dockerCompose,
  restic: runRestic,
  reconcile: reconcileUnlocked,
  now: Date.now
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
  await withOperationLock(files.lock, 'backup', async () => {
    await backupUnlocked(root)
  })
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

    if (previouslyRunning.includes('gitea-mirror')) {
      try {
        if (!previouslyRunning.includes('forgejo')) throw new Error('Forgejo is not running; online reconciliation could not start')
        await dependencies.reconcile(root)
      } catch (error) {
        reconciliationFailure = error
      }
    }

    try {
      if (previouslyRunning.includes('gitea-mirror')) dependencies.compose(root, ['stop', '--timeout', '60', 'gitea-mirror'])
      if (previouslyRunning.includes('forgejo')) dependencies.compose(root, ['stop', '--timeout', '60', 'forgejo'])

      const output = dependencies.restic(root, values, [
        'backup', '--json',
        '/source/.env', '/source/deployment.json', '/source/compose.yaml',
        '/source/.cli/package.json', '/source/.cli/package-lock.json', '/source/data'
      ])
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
      lifecycleFailure = error
    } finally {
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
        dependencies.restic(root, values, [
          'forget', '--prune',
          '--keep-daily', values.KEEP_DAILY ?? String(defaults.keepDaily),
          '--keep-weekly', values.KEEP_WEEKLY ?? String(defaults.keepWeekly),
          '--keep-monthly', values.KEEP_MONTHLY ?? String(defaults.keepMonthly)
        ])
        dependencies.restic(root, values, ['check'])
        subset = nextSubset(files)
        dependencies.restic(root, values, ['check', `--read-data-subset=${subset}/7`])
        writeJson(files.verifyState, { subset })
      } catch (error) {
        lifecycleFailure = error
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
    if (lifecycleFailure) throw new Error(lifecycleError)
    if (reconciliationFailure) throw new Error(reconciliationError)
    console.log(`Backup complete${snapshotId ? `: ${snapshotId}` : ''}`)
}
