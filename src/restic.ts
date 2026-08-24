import { spawnSync } from 'node:child_process'
import { images } from './constants.js'
import type { S3Config } from './types.js'

export type ResticResult = {
  status: number
  stdout: string
  stderr: string
}

function resticEnvironment(s3: S3Config): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RESTIC_REPOSITORY: resticUrl(s3),
    RESTIC_PASSWORD: s3.resticPassword,
    AWS_ACCESS_KEY_ID: s3.accessKeyId,
    AWS_SECRET_ACCESS_KEY: s3.secretAccessKey,
    AWS_DEFAULT_REGION: s3.region
  }
}

function resticUrl(s3: S3Config): string {
  const endpoint = s3.endpoint.replace(/\/$/, '')
  const prefix = s3.prefix.replace(/^\/+|\/+$/g, '')
  return `s3:${endpoint}/${s3.bucket}${prefix ? `/${prefix}` : ''}`
}

export function runResticContainer(s3: S3Config, args: string[], mount?: { host: string, container: string }): ResticResult {
  const dockerArgs = [
    'run', '--rm',
    '--env', 'RESTIC_REPOSITORY',
    '--env', 'RESTIC_PASSWORD',
    '--env', 'AWS_ACCESS_KEY_ID',
    '--env', 'AWS_SECRET_ACCESS_KEY',
    '--env', 'AWS_DEFAULT_REGION'
  ]
  if (mount) dockerArgs.push('--volume', `${mount.host}:${mount.container}`)
  dockerArgs.push(images.restic)
  if (s3.forcePathStyle) dockerArgs.push('-o', 's3.bucket-lookup=path')
  dockerArgs.push(...args)

  const result = spawnSync('docker', dockerArgs, {
    encoding: 'utf8',
    env: resticEnvironment(s3),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.error) throw result.error
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  }
}

export function resticOptionsFromEnvironment(values: Record<string, string>): string[] {
  return values.S3_FORCE_PATH_STYLE === 'true' ? ['-o', 's3.bucket-lookup=path'] : []
}
