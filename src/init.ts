import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaults, images, PACKAGE_VERSION, SCHEMA_VERSION } from './constants.js'
import { acquireGitHubIdentity } from './github.js'
import { writeAtomic, writeJson } from './files.js'
import { installPinnedCli } from './install.js'
import { deploymentFiles, deploymentPath, resolveUserContext } from './paths.js'
import { assertDistinctAvailablePorts, assertNoOtherInstance, assertPrerequisites, portAvailable } from './preflight.js'
import {
  generateSecret,
  promptConfirm,
  promptIntro,
  promptMultiple,
  promptNote,
  promptNumber,
  promptOutro,
  promptRequired,
  promptSecret,
  promptSelect,
  promptText
} from './prompts.js'
import { provision } from './provision.js'
import { run } from './process.js'
import { runResticContainer } from './restic.js'
import { installTimer } from './systemd.js'
import { createManifest, renderCompose, renderEnvironment, renderPinnedPackage } from './templates.js'
import type { DeploymentManifest, InitAnswers, S3Config } from './types.js'

async function selectPort(label: string, preferred: number): Promise<number> {
  if (await portAvailable(preferred)) return preferred
  console.warn(`${label} default port ${preferred} is occupied.`)
  return await promptNumber(label, preferred + 1, value => value >= 1024 && value <= 65535)
}

export async function collectS3(generateResticPassword = false): Promise<S3Config> {
  promptNote(
    'Backups are encrypted by restic before upload. Use credentials scoped to one bucket and prefix; ghark needs read, write, list, and delete access for retention.',
    'Backup storage'
  )
  const provider = await promptSelect('Where should ghark store backups?', [
    { value: 'aws', label: 'AWS S3', hint: 'Amazon S3 bucket' },
    { value: 'r2', label: 'Cloudflare R2', hint: 'S3-compatible, no egress fees' },
    { value: 'custom', label: 'Custom S3-compatible', hint: 'MinIO, Backblaze B2, Wasabi, or another provider' }
  ], 'aws')

  let endpoint: string
  let region: string
  let forcePathStyle = false
  if (provider === 'aws') {
    promptNote('Use an IAM access key restricted to the backup bucket and prefix. Do not use AWS root-account credentials.', 'AWS credentials')
    region = await promptRequired('AWS region', 'us-east-1')
    endpoint = `https://s3.${region}.amazonaws.com`
    promptNote(`Using ${endpoint}. Create or choose a bucket in the same region to avoid cross-region transfer.`, 'AWS S3')
  } else if (provider === 'r2') {
    promptNote('Find the account ID on the R2 Overview page. If the bucket has a jurisdiction, choose the matching endpoint below.', 'R2 endpoint')
    const accountId = await promptRequired('Cloudflare account ID')
    const jurisdiction = await promptSelect('R2 bucket jurisdiction', [
      { value: '', label: 'Default', hint: 'Most R2 buckets' },
      { value: '.eu', label: 'European Union (EU)' },
      { value: '.us', label: 'United States (US)' },
      { value: '.fedramp', label: 'FedRAMP' }
    ], '')
    endpoint = `https://${accountId}${jurisdiction}.r2.cloudflarestorage.com`
    region = 'auto'
    promptNote('Create the backup bucket in R2 first. Below, enter its exact bucket name (for example, ghark-backups), not its URL. Then use an R2 API token with Object Read & Write permission scoped to that bucket.', 'Cloudflare R2')
  } else {
    endpoint = await promptRequired('S3 endpoint (including https://)')
    if (!/^https?:\/\//.test(endpoint)) throw new Error('S3 endpoint must begin with http:// or https://')
    region = await promptRequired('S3 region', 'us-east-1')
    promptNote('Path-style addressing puts the bucket in the URL path. Enable it for providers such as MinIO that do not support bucket-name subdomains.', 'Custom endpoint')
    forcePathStyle = await promptConfirm('Use path-style S3 addressing?', false)
  }

  const bucketLabel = provider === 'r2'
    ? 'R2 bucket name (for example, ghark-backups)'
    : provider === 'aws'
      ? 'AWS S3 bucket name (for example, ghark-backups)'
      : 'Bucket name (not the endpoint URL)'
  const bucket = await promptRequired(bucketLabel)
  const prefix = await promptText('Bucket prefix (keeps ghark backups in their own folder)', 'ghark')
  const accessKeyId = await promptRequired(provider === 'r2' ? 'R2 access key ID' : 'S3 access key ID')
  const secretAccessKey = await promptSecret(provider === 'r2' ? 'R2 secret access key' : 'S3 secret access key')
  const resticPassword = generateResticPassword
    ? generateSecret(32)
    : await promptSecret('Existing restic repository password')
  return { endpoint, region, bucket, prefix, accessKeyId, secretAccessKey, forcePathStyle, resticPassword }
}

function initializeRestic(s3: S3Config): void {
  const snapshots = runResticContainer(s3, ['snapshots', '--json'])
  if (snapshots.status === 0) {
    console.log('Using existing restic repository.')
    return
  }
  const combined = `${snapshots.stdout}\n${snapshots.stderr}`
  if (!/repository|config file/i.test(combined)) throw new Error(`Could not access S3: ${combined.trim()}`)
  const initialized = runResticContainer(s3, ['init'])
  if (initialized.status !== 0) throw new Error(`Could not initialize restic: ${initialized.stderr.trim()}`)
  console.log('Initialized encrypted restic repository.')
}

async function collectAnswers(): Promise<InitAnswers> {
  promptIntro('ghark init — create your GitHub warm standby')
  promptNote(
    'This wizard connects GitHub, chooses exactly which owners to mirror, configures the local services, and sets up encrypted off-machine backups.',
    'What happens next'
  )
  const github = await acquireGitHubIdentity()
  if (github.organizations.length > 0) {
    promptNote(
      'Choose organizations with the arrow keys and toggle them with Space. Press Enter when done. An empty selection means no organizations, never all organizations.',
      'Repository owners'
    )
  } else {
    promptNote('This GitHub credential cannot see any organizations, so only the personal-account choice is available.', 'Repository owners')
  }
  const organizations = await promptMultiple('Which organizations should ghark mirror?', github.organizations)
  const includePersonal = await promptConfirm(`Mirror repositories owned by ${github.login}?`, true)
  if (!includePersonal && organizations.length === 0) {
    throw new Error('Select personal repositories, at least one organization, or both')
  }

  promptNote(
    'Forgejo is the warm standby; Gitea Mirror keeps it synchronized from GitHub. Both local services use this administrator account.',
    'Local administrator'
  )
  const adminUsername = await promptRequired('Shared administrator username', github.login)
  const adminEmail = await promptRequired('Administrator email', `${github.login}@users.noreply.github.com`)
  const adminPassword = generateSecret(24)
  promptNote(
    'Choose No for a new bucket or prefix. Choose Yes only when reconnecting to an existing restic repository, whose password you will need.',
    'Restic repository'
  )
  const useExistingRestic = await promptConfirm('Does the S3 location already contain a restic repository?', false)
  const s3 = await collectS3(!useExistingRestic)
  const forgejoHttpPort = await selectPort('Forgejo HTTP port', defaults.forgejoHttpPort)
  const forgejoSshPort = await selectPort('Forgejo SSH port', defaults.forgejoSshPort)
  const mirrorPort = await selectPort('Gitea Mirror port', defaults.mirrorPort)
  await assertDistinctAvailablePorts([forgejoHttpPort, forgejoSshPort, mirrorPort])

  console.log('\nSave these recovery credentials outside this VM:')
  console.log(`  Administrator password: ${adminPassword}`)
  console.log(`  Restic password:        ${s3.resticPassword}`)
  if (!await promptConfirm('Have you stored both credentials safely?', false)) {
    throw new Error('Initialization stopped until recovery credentials are stored')
  }

  promptOutro('Configuration collected. Creating the deployment…')

  return {
    adminUsername,
    adminEmail,
    adminPassword,
    github,
    includePersonal,
    organizations,
    s3,
    forgejoHttpPort,
    forgejoSshPort,
    mirrorPort,
    backupTime: defaults.backupTime
  }
}

export async function initialize(): Promise<void> {
  const user = resolveUserContext()
  const root = deploymentPath(user)
  const files = deploymentFiles(root)
  assertPrerequisites()
  assertNoOtherInstance(root)

  if (existsSync(files.manifest)) {
    console.log(`Reconciling existing deployment at ${root}`)
    const manifest = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(files.manifest, 'utf8'))) as DeploymentManifest
    if (manifest.schemaVersion > SCHEMA_VERSION) throw new Error(`Deployment schema ${manifest.schemaVersion} is newer than this ghark release`)
    writeAtomic(files.compose, renderCompose())
    writeJson(files.manifest, {
      ...manifest,
      schemaVersion: SCHEMA_VERSION,
      gharkVersion: PACKAGE_VERSION,
      images: { ...images }
    })
    installPinnedCli(root, user)
    await provision(root)
    installTimer(root, manifest.backupTime, user)
    return
  }
  if (existsSync(root)) throw new Error(`${root} already exists but is not a ghark deployment`)

  const answers = await collectAnswers()
  initializeRestic(answers.s3)

  const staging = join(dirname(root), `.ghark-init-${process.pid}`)
  rmSync(staging, { recursive: true, force: true })
  const stagingFiles = deploymentFiles(staging)
  try {
    mkdirSync(join(stagingFiles.data, 'forgejo'), { recursive: true })
    mkdirSync(join(stagingFiles.data, 'gitea-mirror'), { recursive: true })
    writeAtomic(stagingFiles.compose, renderCompose())
    writeAtomic(stagingFiles.env, renderEnvironment(answers, user), 0o600)
    writeJson(stagingFiles.manifest, createManifest(answers, user))
    mkdirSync(stagingFiles.cli, { recursive: true })
    writeAtomic(join(stagingFiles.cli, 'package.json'), renderPinnedPackage())
    renameSync(staging, root)

    installPinnedCli(root, user)
    if (process.getuid?.() === 0 && user.uid !== 0) run('chown', ['-R', `${user.uid}:${user.gid}`, root])
    await provision(root)
    installTimer(root, answers.backupTime, user)
  } catch (error) {
    if (!existsSync(root)) rmSync(staging, { recursive: true, force: true })
    throw error
  }

  console.log('\nGhark is ready.')
  console.log(`Forgejo:     http://127.0.0.1:${answers.forgejoHttpPort}`)
  console.log(`Gitea Mirror: http://127.0.0.1:${answers.mirrorPort}`)
}
