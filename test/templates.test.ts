import assert from 'node:assert/strict'
import test from 'node:test'
import { createEnvironment, createManifest, renderCompose, resticRepository } from '../src/templates.js'
import { PACKAGE_VERSION } from '../src/constants.js'
import type { InitAnswers, UserContext } from '../src/types.js'

const user: UserContext = { username: 'marc', uid: 1000, gid: 1000, home: '/home/marc' }
const answers: InitAnswers = {
  adminUsername: 'marc',
  adminEmail: 'marc@example.com',
  adminPassword: 'admin-password',
  github: { login: 'marc', token: 'github-token', scopes: ['repo', 'read:org'], organizations: ['acme', 'other'] },
  includePersonal: true,
  organizations: ['acme'],
  s3: {
    endpoint: 'http://minio:9000/',
    region: 'us-east-1',
    bucket: 'backups',
    prefix: '/ghark/',
    accessKeyId: 'minio',
    secretAccessKey: 'minio-secret',
    forcePathStyle: true,
    resticPassword: 'restic-password'
  },
  forgejoHttpPort: 3000,
  forgejoSshPort: 2222,
  mirrorPort: 4321,
  backupTime: '03:17'
}

test('restic repository path is normalized', () => {
  assert.equal(resticRepository('http://minio:9000/', 'backups', '/ghark/'), 's3:http://minio:9000/backups/ghark')
})

test('runtime and package versions stay aligned', async () => {
  const packageJson = await import('../package.json', { with: { type: 'json' } })
  assert.equal(PACKAGE_VERSION, packageJson.default.version)
})

test('organization choices become an explicit allowlist', () => {
  const environment = createEnvironment(answers, user)
  assert.equal(environment.INCLUDE_ORGANIZATIONS, 'acme')
  assert.equal(environment.MIRROR_ORGANIZATIONS, 'true')
  assert.equal(environment.ONLY_MIRROR_ORGS, 'false')
  assert.equal(environment.INCLUDE_PERSONAL, 'true')
})

test('manifest excludes credentials', () => {
  const manifest = JSON.stringify(createManifest(answers, user))
  assert.equal(manifest.includes('github-token'), false)
  assert.equal(manifest.includes('restic-password'), false)
  assert.equal(manifest.includes('minio-secret'), false)
})

test('services receive only their required secret classes', () => {
  const compose = renderCompose()
  const restic = compose.slice(compose.indexOf('  restic:'))
  assert.match(restic, /RESTIC_PASSWORD/)
  assert.doesNotMatch(restic, /GITHUB_TOKEN|ADMIN_PASSWORD|FORGEJO_TOKEN/)
  assert.match(compose, /INCLUDE_ORGANIZATIONS/)
  assert.match(compose, /127\.0\.0\.1:/)
})
