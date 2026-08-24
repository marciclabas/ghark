import { readFileSync } from 'node:fs'
import { acquireGitHubIdentity } from './github.js'
import { parseEnv, serializeEnv } from './env.js'
import { writeAtomic, writeJson } from './files.js'
import { collectS3 } from './init.js'
import { deploymentFiles } from './paths.js'
import { promptConfirm, promptMultiple } from './prompts.js'
import { dockerCompose } from './process.js'
import { runResticContainer } from './restic.js'
import type { DeploymentManifest } from './types.js'

export async function configureGitHub(root: string): Promise<void> {
  const files = deploymentFiles(root)
  const identity = await acquireGitHubIdentity()
  const organizations = await promptMultiple('Select organizations to mirror:', identity.organizations)
  const includePersonal = await promptConfirm(`Mirror repositories owned by ${identity.login}?`, true)
  if (!includePersonal && organizations.length === 0) throw new Error('Nothing selected to mirror')

  const values = parseEnv(readFileSync(files.env, 'utf8'))
  values.GITHUB_USERNAME = identity.login
  values.GITHUB_TOKEN = identity.token
  values.INCLUDE_PERSONAL = String(includePersonal)
  values.INCLUDE_ORGANIZATIONS = organizations.join(',')
  values.MIRROR_ORGANIZATIONS = String(organizations.length > 0)
  values.ONLY_MIRROR_ORGS = String(!includePersonal)
  writeAtomic(files.env, serializeEnv(values), 0o600)

  const manifest = JSON.parse(readFileSync(files.manifest, 'utf8')) as DeploymentManifest
  manifest.github = { username: identity.login, includePersonal, organizations }
  writeJson(files.manifest, manifest)
  dockerCompose(root, ['up', '--detach', '--force-recreate', 'gitea-mirror'])
  console.log('GitHub configuration updated.')
  console.warn('Existing Forgejo pull mirrors may retain their previous GitHub credential; update their mirror authorization in Forgejo if synchronization reports authentication failures.')
}

export async function configureBackup(root: string): Promise<void> {
  const s3 = await collectS3(false)
  const check = runResticContainer(s3, ['snapshots', '--json'])
  if (check.status !== 0) throw new Error('The new restic repository must already exist; use ghark init for a new deployment')
  const files = deploymentFiles(root)
  const values = parseEnv(readFileSync(files.env, 'utf8'))
  const endpoint = s3.endpoint.replace(/\/$/, '')
  const prefix = s3.prefix.replace(/^\/+|\/+$/g, '')
  values.RESTIC_REPOSITORY = `s3:${endpoint}/${s3.bucket}${prefix ? `/${prefix}` : ''}`
  values.RESTIC_PASSWORD = s3.resticPassword
  values.AWS_ACCESS_KEY_ID = s3.accessKeyId
  values.AWS_SECRET_ACCESS_KEY = s3.secretAccessKey
  values.AWS_DEFAULT_REGION = s3.region
  values.S3_ENDPOINT = s3.endpoint.replace(/\/$/, '')
  values.S3_BUCKET = s3.bucket
  values.S3_PREFIX = s3.prefix.replace(/^\/+|\/+$/g, '')
  values.S3_FORCE_PATH_STYLE = String(s3.forcePathStyle)
  writeAtomic(files.env, serializeEnv(values), 0o600)
  console.log('Backup configuration updated.')
}
