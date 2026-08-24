import { existsSync, readFileSync } from 'node:fs'
import { backupUnlocked } from './backup.js'
import { PACKAGE_NAME, PACKAGE_VERSION } from './constants.js'
import { parseEnv, redact } from './env.js'
import { withOperationLock } from './lock.js'
import { deploymentFiles } from './paths.js'
import { dockerCompose, run, runCapture } from './process.js'
import { resticOptionsFromEnvironment } from './restic.js'
import type { BackupState, DeploymentManifest, ReconcileState } from './types.js'

export function assertDeployment(root: string): void {
  if (!existsSync(deploymentFiles(root).manifest)) throw new Error(`No ghark deployment found at ${root}`)
}

export function up(root: string): void {
  assertDeployment(root)
  dockerCompose(root, ['pull'])
  dockerCompose(root, ['up', '--detach'])
}

export function down(root: string): void {
  assertDeployment(root)
  dockerCompose(root, ['down'])
}

export function status(root: string): void {
  assertDeployment(root)
  const files = deploymentFiles(root)
  const manifest = JSON.parse(readFileSync(files.manifest, 'utf8')) as DeploymentManifest
  console.log(`Deployment: ${root}`)
  console.log(`Forgejo: http://127.0.0.1:${manifest.ports.forgejoHttp}`)
  console.log(`Gitea Mirror: http://127.0.0.1:${manifest.ports.mirror}`)
  console.log(`Tunnel: ssh -L ${manifest.ports.forgejoHttp}:127.0.0.1:${manifest.ports.forgejoHttp} -L ${manifest.ports.mirror}:127.0.0.1:${manifest.ports.mirror} HOST`)
  console.log(`Storage: ${runCapture('du', ['-sh', files.data], { allowFailure: true, quiet: true }).trim().split(/\s+/)[0] ?? 'unknown'}`)
  console.log('\nServices:')
  console.log(dockerCompose(root, ['ps'], { quiet: true }).trim())
  if (existsSync(files.backupState)) {
    const state = JSON.parse(readFileSync(files.backupState, 'utf8')) as BackupState
    const health = state.degraded ? 'DEGRADED' : state.success ? 'healthy' : 'FAILED'
    console.log(`\nLatest backup: ${health} at ${state.completedAt ?? 'unknown'}`)
    if (state.snapshotId) console.log(`Snapshot: ${state.snapshotId}`)
    if (state.reconciliationError) console.log(`Reconciliation: ${state.reconciliationError}`)
    if (state.error) console.log(`Error: ${state.error}`)
  } else {
    console.log('\nLatest backup: none')
  }
  if (existsSync(files.reconcileState)) {
    const state = JSON.parse(readFileSync(files.reconcileState, 'utf8')) as ReconcileState
    console.log(`\nLatest reconciliation: ${state.success ? 'complete' : 'FAILED'} at ${state.completedAt || 'unknown'}`)
    console.log(`Repositories: ${state.repositoriesScanned}; release units enabled: ${state.releaseUnitsEnabled}; repositories resynced: ${state.repositoriesResynced}`)
    console.log(`Releases: ${state.releasesScanned}; assets uploaded/replaced/skipped: ${state.assetsUploaded}/${state.assetsReplaced}/${state.assetsSkipped}`)
    if (state.warnings.length > 0) console.log(`Warnings: ${state.warnings.length}`)
    if (state.error) console.log(`Reconciliation error: ${state.error}`)
  } else {
    console.log('\nLatest reconciliation: none')
  }
  const timer = systemdStatus(['show', 'ghark-backup.timer', '--property=ActiveState,NextElapseUSecRealtime'])
  if (timer) console.log(`\nTimer:\n${timer.trim()}`)
}

function systemdStatus(args: string[]): string {
  try {
    return runCapture('systemctl', args, { allowFailure: true, quiet: true })
  } catch {
    return ''
  }
}

export function logs(root: string, service?: string): void {
  assertDeployment(root)
  if (service && !['forgejo', 'gitea-mirror', 'restic'].includes(service)) throw new Error(`Unknown service: ${service}`)
  const files = deploymentFiles(root)
  const values = parseEnv(readFileSync(files.env, 'utf8'))
  const output = dockerCompose(root, ['logs', '--tail', '200', ...(service ? [service] : [])], { quiet: true })
  const secretKeys = [
    'ADMIN_PASSWORD', 'FORGEJO_SECRET_KEY', 'FORGEJO_INTERNAL_TOKEN', 'FORGEJO_TOKEN',
    'BETTER_AUTH_SECRET', 'ENCRYPTION_SECRET', 'GITHUB_TOKEN', 'RESTIC_PASSWORD',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'
  ]
  console.log(redact(output, secretKeys.flatMap(key => values[key] ? [values[key]] : [])))
}

export function snapshots(root: string): void {
  assertDeployment(root)
  const values = parseEnv(readFileSync(deploymentFiles(root).env, 'utf8'))
  console.log(dockerCompose(root, ['run', '--rm', 'restic', ...resticOptionsFromEnvironment(values), 'snapshots'], { quiet: true }))
}

export function verify(root: string, full: boolean): void {
  assertDeployment(root)
  const values = parseEnv(readFileSync(deploymentFiles(root).env, 'utf8'))
  dockerCompose(root, ['config', '--quiet'])
  dockerCompose(root, ['run', '--rm', 'restic', ...resticOptionsFromEnvironment(values), 'check', ...(full ? ['--read-data'] : [])])
  console.log('Compose and restic verification passed.')
}

export async function update(root: string): Promise<void> {
  assertDeployment(root)
  const files = deploymentFiles(root)
  await withOperationLock(files.lock, 'update', async () => {
    await backupUnlocked(root)
    const latest = runCapture('npm', ['view', PACKAGE_NAME, 'version'], { quiet: true }).trim()
    if (!latest) throw new Error(`npm did not return a version for ${PACKAGE_NAME}`)
    if (latest !== PACKAGE_VERSION) {
      const cliRoot = files.cli
      run('npm', ['install', '--omit=dev', '--save-exact', '--prefix', cliRoot, `${PACKAGE_NAME}@${latest}`])
      const binary = `${cliRoot}/node_modules/.bin/ghark`
      run(binary, ['init'], { env: { ...process.env, GHARK_SKIP_SELF_INSTALL: '1' } })
      console.log(`Updated ghark ${PACKAGE_VERSION} → ${latest}`)
      return
    }
    dockerCompose(root, ['pull'])
    dockerCompose(root, ['up', '--detach'])
    console.log(`Ghark ${PACKAGE_VERSION} is current; pinned images reconciled.`)
  })
}

export function stopSync(root: string): void {
  assertDeployment(root)
  dockerCompose(root, ['stop', 'gitea-mirror'])
  console.log('Synchronization stopped. Keep it stopped after the first Forgejo write.')
}

export function failoverGuide(root: string): void {
  assertDeployment(root)
  console.log(`1. Inspect ghark status and confirm the latest synchronization.\n2. Run ghark stop-sync.\n3. Run ghark backup if S3 is reachable.\n4. In Forgejo, convert one low-risk pull mirror to a regular repository.\n5. Verify a test push, then promote repositories deliberately.\n6. Change developer remotes. Never restart Gitea Mirror after the first Forgejo write.`)
}
