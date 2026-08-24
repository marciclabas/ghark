import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { collectS3 } from './init.js'
import { installPinnedCli } from './install.js'
import { withOperationLock } from './lock.js'
import { deploymentFiles, deploymentPath, resolveUserContext } from './paths.js'
import { promptConfirm, promptText } from './prompts.js'
import { dockerCompose, privileged } from './process.js'
import { runResticContainer } from './restic.js'
import { installTimer } from './systemd.js'
import { provision } from './provision.js'
import type { DeploymentManifest, S3Config } from './types.js'

function s3FromDeployment(root: string): S3Config {
  const content = readFileSync(deploymentFiles(root).env, 'utf8')
  const values = Object.fromEntries(content.split(/\r?\n/).flatMap(line => {
    const index = line.indexOf('=')
    if (index < 1) return []
    const key = line.slice(0, index)
    let value = line.slice(index + 1)
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replaceAll("'\\''", "'")
    return [[key, value]]
  }))
  if (values.S3_ENDPOINT && values.S3_BUCKET) {
    return {
      endpoint: values.S3_ENDPOINT,
      bucket: values.S3_BUCKET,
      prefix: values.S3_PREFIX ?? '',
      region: values.AWS_DEFAULT_REGION ?? 'us-east-1',
      accessKeyId: values.AWS_ACCESS_KEY_ID ?? '',
      secretAccessKey: values.AWS_SECRET_ACCESS_KEY ?? '',
      resticPassword: values.RESTIC_PASSWORD ?? '',
      forcePathStyle: values.S3_FORCE_PATH_STYLE === 'true'
    }
  }
  const repository = values.RESTIC_REPOSITORY ?? ''
  const match = repository.match(/^s3:(https?:\/\/[^/]+)\/([^/]+)(?:\/(.*))?$/)
  if (!match?.[1] || !match[2]) throw new Error('Cannot parse the configured S3 repository')
  return {
    endpoint: match[1],
    bucket: match[2],
    prefix: match[3] ?? '',
    region: values.AWS_DEFAULT_REGION ?? 'us-east-1',
    accessKeyId: values.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: values.AWS_SECRET_ACCESS_KEY ?? '',
    resticPassword: values.RESTIC_PASSWORD ?? '',
    forcePathStyle: values.S3_FORCE_PATH_STYLE === 'true'
  }
}

export async function restore(requestedSnapshot?: string): Promise<void> {
  const user = resolveUserContext()
  const root = deploymentPath(user)
  const parent = dirname(root)
  const lock = deploymentFiles(root).lock
  await withOperationLock(lock, 'restore', async () => {
    const hasDeployment = existsSync(deploymentFiles(root).manifest)
    const s3 = hasDeployment ? s3FromDeployment(root) : await collectS3(false)
    const snapshots = runResticContainer(s3, ['snapshots', '--json'])
    if (snapshots.status !== 0) throw new Error(`Cannot open restic repository: ${snapshots.stderr.trim()}`)

    let snapshot = requestedSnapshot
    if (!snapshot) {
      const parsed = JSON.parse(snapshots.stdout) as Array<{ short_id?: string, time?: string }>
      if (parsed.length === 0) throw new Error('The restic repository has no snapshots')
      console.log('Available snapshots:')
      parsed.slice(-10).reverse().forEach(item => console.log(`  ${item.short_id ?? '?'}  ${item.time ?? ''}`))
      snapshot = await promptText('Snapshot to restore', 'latest')
    }

    if (hasDeployment && !await promptConfirm(`Replace ${root} with snapshot ${snapshot}? The current deployment will be retained beside it.`, false)) {
      throw new Error('Restore cancelled')
    }

    const staging = join(parent, `.ghark-restore-${process.pid}`)
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    const result = runResticContainer(s3, ['restore', snapshot, '--target', '/restore'], { host: staging, container: '/restore' })
    if (result.status !== 0) {
      rmSync(staging, { recursive: true, force: true })
      throw new Error(`Restore failed: ${result.stderr.trim()}`)
    }

    const restored = join(staging, 'source')
    const manifestPath = deploymentFiles(restored).manifest
    if (!existsSync(manifestPath)) {
      rmSync(staging, { recursive: true, force: true })
      throw new Error('Snapshot does not contain a valid ghark deployment')
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DeploymentManifest
    if (manifest.schemaVersion !== 1) throw new Error(`Unsupported deployment schema ${manifest.schemaVersion}`)

    let retained: string | undefined
    if (existsSync(root)) {
      retained = `${root}.before-restore-${new Date().toISOString().replaceAll(':', '-')}`
      dockerCompose(root, ['down'], { allowFailure: true })
      renameSync(root, retained)
    }
    renameSync(restored, root)
    rmSync(staging, { recursive: true, force: true })
    privileged('chown', ['-R', `${user.uid}:${user.gid}`, root])

    installPinnedCli(root, user)
    dockerCompose(root, ['config', '--quiet'])
    await provision(root)
    installTimer(root, manifest.backupTime, user)
    console.log(`Restored snapshot ${snapshot} to ${root}`)
    if (retained) console.log(`Previous deployment retained at ${retained}`)
  })
}
