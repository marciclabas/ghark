import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseEnv, serializeEnv } from '../src/env.js'
import { writeAtomic } from '../src/files.js'
import { validateGitHubToken } from '../src/github.js'
import { dockerCompose, privileged } from '../src/process.js'
import { provision } from '../src/provision.js'
import { reconcileUnlocked } from '../src/reconcile.js'
import { createEnvironment, createManifest, renderCompose } from '../src/templates.js'
import { writeJson } from '../src/files.js'
import type { InitAnswers, UserContext } from '../src/types.js'

const testValues = parseEnv(readFileSync('.env.test', 'utf8'))
const token = testValues.GHARK_TEST_GITHUB_TOKEN
const sourceRepository = testValues.GHARK_TEST_GITHUB_REPOSITORY
if (!token || !sourceRepository) throw new Error('.env.test requires GHARK_TEST_GITHUB_TOKEN and GHARK_TEST_GITHUB_REPOSITORY')
const [sourceOwner, sourceName] = sourceRepository.split('/')
if (!sourceOwner || !sourceName) throw new Error('GHARK_TEST_GITHUB_REPOSITORY must use owner/name format')

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not allocate a test port'))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

async function waitFor<T>(label: string, callback: () => Promise<T | undefined>, timeoutMilliseconds = 600_000): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const result = await callback()
      if (result !== undefined) return result
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 5_000))
  }
  throw new Error(`${label} timed out${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
}

const identity = await validateGitHubToken(token)
if (identity.login.toLowerCase() !== sourceOwner.toLowerCase()) {
  throw new Error('The authenticated test currently requires a fixture owned by the token user')
}

const root = mkdtempSync(join(tmpdir(), 'ghark-github-test-'))
process.env.GHARK_COMPOSE_PROJECT = `ghark-github-test-${process.pid}`
const forgejoHttpPort = await freePort()
const forgejoSshPort = await freePort()
const mirrorPort = await freePort()
const user: UserContext = {
  username: process.env.USER ?? 'ghark',
  uid: process.getuid?.() ?? 1000,
  gid: process.getgid?.() ?? 1000,
  home: root
}
const answers: InitAnswers = {
  adminUsername: 'gharkadmin',
  adminEmail: 'ghark@example.invalid',
  adminPassword: 'ghark-github-test-password',
  github: identity,
  includePersonal: true,
  organizations: [],
  s3: {
    endpoint: 'http://127.0.0.1:19000',
    region: 'us-east-1',
    bucket: 'unused',
    prefix: 'unused',
    accessKeyId: 'unused',
    secretAccessKey: 'unused',
    forcePathStyle: true,
    resticPassword: 'unused-test-password'
  },
  forgejoHttpPort,
  forgejoSshPort,
  mirrorPort,
  backupTime: '03:17'
}

try {
  mkdirSync(join(root, 'data', 'forgejo'), { recursive: true })
  mkdirSync(join(root, 'data', 'gitea-mirror'), { recursive: true })
  writeAtomic(join(root, 'compose.yaml'), renderCompose())
  writeJson(join(root, 'deployment.json'), createManifest(answers, user))
  const environment = createEnvironment(answers, user)
  environment.SCHEDULE_ENABLED = 'false'
  environment.AUTO_IMPORT_REPOS = 'false'
  environment.AUTO_MIRROR_REPOS = 'false'
  environment.GITEA_MIRROR_INTERVAL = ''
  writeAtomic(join(root, '.env'), serializeEnv(environment), 0o600)
  await provision(root)

  const currentEnvironment = parseEnv(readFileSync(join(root, '.env'), 'utf8'))
  const forgejoToken = currentEnvironment.FORGEJO_TOKEN
  if (!forgejoToken) throw new Error('Forgejo provisioning did not return a token')
  const mirrorUrl = `http://127.0.0.1:${mirrorPort}`
  const forgejoUrl = `http://127.0.0.1:${forgejoHttpPort}`

  const signIn = await fetch(`${mirrorUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: mirrorUrl },
    body: JSON.stringify({ email: answers.adminEmail, password: answers.adminPassword })
  })
  if (!signIn.ok) throw new Error(`Gitea Mirror sign-in failed (${signIn.status})`)
  const cookie = signIn.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const mirrorHeaders = { Cookie: cookie, Origin: mirrorUrl }

  const imported = await fetch(`${mirrorUrl}/api/sync`, { method: 'POST', headers: mirrorHeaders })
  if (!imported.ok) throw new Error(`GitHub repository import failed (${imported.status}): ${await imported.text()}`)
  const repositories = await fetch(`${mirrorUrl}/api/github/repositories`, { headers: mirrorHeaders })
  if (!repositories.ok) throw new Error(`Could not list imported repositories (${repositories.status})`)
  const repositoryPayload = await repositories.json() as { repositories?: Array<{ id?: string, fullName?: string }> }
  const fixture = repositoryPayload.repositories?.find(repository => repository.fullName?.toLowerCase() === sourceRepository.toLowerCase())
  if (!fixture?.id) throw new Error(`Fixture ${sourceRepository} was not imported by Gitea Mirror`)

  const startMirror = async (): Promise<void> => {
    const mirror = await fetch(`${mirrorUrl}/api/job/mirror-repo`, {
      method: 'POST',
      headers: { ...mirrorHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repositoryIds: [fixture.id] })
    })
    if (!mirror.ok) throw new Error(`Fixture mirror job failed to start (${mirror.status}): ${await mirror.text()}`)
  }
  await startMirror()

  type ForgejoRepository = { full_name?: string, name?: string, owner?: { login?: string } }
  const destination = await waitFor<ForgejoRepository>('Forgejo repository creation', async () => {
    const response = await fetch(`${forgejoUrl}/api/v1/repos/search?q=${encodeURIComponent(sourceName)}&limit=50`, {
      headers: { Authorization: `token ${forgejoToken}` }
    })
    if (!response.ok) return undefined
    const payload = await response.json() as { data?: ForgejoRepository[] }
    return payload.data?.find(repository => repository.name === sourceName)
  })
  if (!destination.full_name) throw new Error('Mirrored Forgejo repository has no full name')

  const apiPath = destination.full_name.split('/').map(encodeURIComponent).join('/')
  const initialRepositoryResponse = await fetch(`${forgejoUrl}/api/v1/repos/${apiPath}`, {
    headers: { Authorization: `token ${forgejoToken}` }
  })
  if (!initialRepositoryResponse.ok) throw new Error(`Could not inspect the fixture destination (${initialRepositoryResponse.status})`)
  const initialRepository = await initialRepositoryResponse.json() as { has_releases?: boolean }
  if (initialRepository.has_releases !== false) throw new Error('Fixture destination unexpectedly started with its Releases unit enabled')
  await waitFor('mirrored release tag', async () => {
    const response = await fetch(`${forgejoUrl}/api/v1/repos/${apiPath}/tags/v0.1.0`, {
      headers: { Authorization: `token ${forgejoToken}` }
    })
    return response.ok ? true : undefined
  })
  await waitFor('metadata mirroring', async () => {
    const [issuesResponse, labelsResponse, milestonesResponse] = await Promise.all([
      fetch(`${forgejoUrl}/api/v1/repos/${apiPath}/issues?state=all&limit=50`, { headers: { Authorization: `token ${forgejoToken}` } }),
      fetch(`${forgejoUrl}/api/v1/repos/${apiPath}/labels`, { headers: { Authorization: `token ${forgejoToken}` } }),
      fetch(`${forgejoUrl}/api/v1/repos/${apiPath}/milestones?state=all`, { headers: { Authorization: `token ${forgejoToken}` } })
    ])
    if (![issuesResponse, labelsResponse, milestonesResponse].every(response => response.ok)) return undefined
    const issues = await issuesResponse.json() as Array<{ title?: string }>
    const labels = await labelsResponse.json() as Array<{ name?: string }>
    const milestones = await milestonesResponse.json() as Array<{ title?: string }>
    const complete = issues.some(issue => issue.title?.includes('Mirror issue fixture'))
      && issues.some(issue => issue.title?.includes('Mirror pull request fixture'))
      && labels.some(label => label.name === 'mirror-fixture')
      && milestones.some(milestone => milestone.title === 'Mirror test v1')
    return complete ? { issues, labels, milestones } : undefined
  })

  const clone = join(root, 'clone')
  const basic = Buffer.from(`${answers.adminUsername}:${forgejoToken}`).toString('base64')
  const gitEnvironment = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`
  }
  const cloneResult = spawnSync('git', ['clone', `${forgejoUrl}/${destination.full_name}.git`, clone], {
    encoding: 'utf8', env: gitEnvironment, stdio: 'pipe'
  })
  if (cloneResult.status !== 0) throw new Error(`Could not clone mirrored repository: ${cloneResult.stderr}`)
  const lfsInstallResult = spawnSync('git', ['lfs', 'install', '--local'], {
    cwd: clone, encoding: 'utf8', env: gitEnvironment, stdio: 'pipe'
  })
  if (lfsInstallResult.status !== 0) throw new Error(`Could not initialize Git LFS: ${lfsInstallResult.stderr}`)
  const lfsResult = spawnSync('git', ['lfs', 'pull'], { cwd: clone, encoding: 'utf8', env: gitEnvironment, stdio: 'pipe' })
  if (lfsResult.status !== 0) throw new Error(`Could not fetch mirrored LFS data: ${lfsResult.stderr}`)
  const lfsFile = join(clone, 'fixtures', 'large.bin')
  if (!existsSync(lfsFile) || readFileSync(lfsFile).length !== 1024 * 1024) throw new Error('Mirrored LFS payload is missing or incomplete')

  const firstReconciliation = await reconcileUnlocked(root)
  if (firstReconciliation.releaseUnitsEnabled !== 1 || firstReconciliation.assetsUploaded !== 1) {
    throw new Error(`First reconciliation returned unexpected counters: ${JSON.stringify(firstReconciliation)}`)
  }

  const reconciledRepositoryResponse = await fetch(`${forgejoUrl}/api/v1/repos/${apiPath}`, {
    headers: { Authorization: `token ${forgejoToken}` }
  })
  if (!reconciledRepositoryResponse.ok) throw new Error(`Could not inspect the reconciled fixture (${reconciledRepositoryResponse.status})`)
  const reconciledRepository = await reconciledRepositoryResponse.json() as { has_releases?: boolean }
  if (reconciledRepository.has_releases !== true) throw new Error('Reconciliation did not enable the Forgejo Releases unit')

  const releasesResponse = await fetch(`${forgejoUrl}/api/v1/repos/${apiPath}/releases`, {
    headers: { Authorization: `token ${forgejoToken}` }
  })
  if (!releasesResponse.ok) throw new Error(`Forgejo release listing failed (${releasesResponse.status})`)
  const releases = await releasesResponse.json() as Array<{
    tag_name?: string
    assets?: Array<{ name?: string, size?: number, browser_download_url?: string }>
  }>
  const fixtureRelease = releases.find(release => release.tag_name === 'v0.1.0')
  const fixtureAsset = fixtureRelease?.assets?.find(asset => asset.name === 'release-asset.txt')
  if (!fixtureRelease || !fixtureAsset || fixtureAsset.size !== 28 || !fixtureAsset.browser_download_url) {
    throw new Error('Mirrored release or its private release asset is missing')
  }
  const assetDownload = await fetch(new URL(fixtureAsset.browser_download_url, forgejoUrl), {
    headers: { Authorization: `token ${forgejoToken}` }
  })
  if (!assetDownload.ok || await assetDownload.text() !== 'ghark release asset fixture\n') {
    throw new Error('Reconciled release asset content is incorrect')
  }

  const secondReconciliation = await reconcileUnlocked(root)
  if (secondReconciliation.assetsUploaded !== 0 || secondReconciliation.assetsReplaced !== 0 || secondReconciliation.assetsSkipped !== 1) {
    throw new Error(`Second reconciliation was not idempotent: ${JSON.stringify(secondReconciliation)}`)
  }
  const repositoriesAfterReconciliation = await fetch(`${forgejoUrl}/api/v1/user/repos?limit=50`, {
    headers: { Authorization: `token ${forgejoToken}` }
  })
  if (!repositoriesAfterReconciliation.ok) throw new Error(`Could not list Forgejo repositories (${repositoriesAfterReconciliation.status})`)
  const mirroredRepositories = await repositoriesAfterReconciliation.json() as Array<{ full_name?: string }>
  if (mirroredRepositories.length !== 1 || mirroredRepositories[0]?.full_name !== destination.full_name) {
    throw new Error('The authenticated test mirrored repositories other than its configured fixture')
  }

  console.log(`Authenticated GitHub mirror passed: ${sourceRepository} → ${destination.full_name}`)
} finally {
  dockerCompose(root, ['down', '--volumes'], { allowFailure: true })
  privileged('chown', ['-R', `${user.uid}:${user.gid}`, root])
  rmSync(root, { recursive: true, force: true })
}
