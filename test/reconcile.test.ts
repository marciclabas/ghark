import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  mapRepositories,
  reconcile,
  reconcileUnlocked,
  runReconciliation,
  sanitizeReconciliationError
} from '../src/reconcile.js'
import type { ReconcileConfiguration, ReconcileDependencies } from '../src/reconcile.js'
import { serializeEnv } from '../src/env.js'
import { writeAtomic, writeJson } from '../src/files.js'

const configuration: ReconcileConfiguration = {
  mirrorUrl: 'http://127.0.0.1:4321',
  forgejoUrl: 'http://127.0.0.1:3000',
  administratorEmail: 'admin@example.invalid',
  administratorPassword: 'admin-secret',
  forgejoToken: 'forgejo-secret',
  githubToken: 'github-secret'
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function signedIn(): Response {
  return json({ ok: true }, 200, { 'Set-Cookie': 'session=opaque; Path=/; HttpOnly' })
}

type RequestRecord = { url: string, method: string, headers: Headers, body?: BodyInit | null }

function basicScenario(options: {
  hasReleases?: boolean
  releases?: unknown[]
  forgejoRelease?: unknown
  tagStatus?: number
  uploadStatus?: number
  assetBytes?: Uint8Array
  events?: string[]
  records?: unknown[]
} = {}): { fetch: typeof fetch, requests: RequestRecord[] } {
  const requests: RequestRecord[] = []
  const fetchMock: typeof fetch = async (input, init = {}) => {
    const url = String(input)
    const method = init.method ?? 'GET'
    const headers = new Headers(init.headers)
    requests.push({ url, method, headers, body: init.body })
    const path = new URL(url).pathname
    if (path === '/api/auth/sign-in/email') return signedIn()
    if (path === '/api/github/repositories') {
      return json({ repositories: options.records ?? [{ id: 'mirror-1', fullName: 'source/repo', mirroredLocation: 'backup/repo', status: 'mirrored' }] })
    }
    if (path === '/api/job/sync-repo') return json({ success: true })
    if (path === '/api/v1/repos/backup/repo' && method === 'GET') return json({ has_releases: options.hasReleases ?? true })
    if (path === '/api/v1/repos/backup/repo' && method === 'PATCH') return json({ has_releases: true })
    if (path === '/repos/source/repo/releases') return json(options.releases ?? [])
    if (path === '/api/v1/repos/backup/repo/tags/v1') return json({}, options.tagStatus ?? 200)
    if (path === '/api/v1/repos/backup/repo/releases/tags/v1') {
      return options.forgejoRelease === undefined ? json({}, 404) : json(options.forgejoRelease)
    }
    if (path.endsWith('/assets/8') && method === 'DELETE') {
      options.events?.push('delete')
      return new Response(null, { status: 204 })
    }
    if (path.endsWith('/assets') && method === 'POST') {
      options.events?.push('upload')
      if (options.uploadStatus && options.uploadStatus !== 200) return json({}, options.uploadStatus)
      return json({ id: 9, name: 'asset.bin', size: options.assetBytes?.length ?? 4 })
    }
    if (url === 'https://api.github.test/assets/1') {
      options.events?.push('download')
      return new Response(options.assetBytes ?? new Uint8Array([1, 2, 3, 4]))
    }
    throw new Error(`Unexpected request: ${method} ${url}`)
  }
  return { fetch: fetchMock, requests }
}

test('maps colliding short names only by verified mirror source', async () => {
  const requested: string[] = []
  const fetchMock: typeof fetch = async input => {
    const url = String(input)
    requested.push(url)
    const path = new URL(url).pathname
    if (path === '/api/v1/repos/search') {
      return json({ data: [
        { full_name: 'dest-one/shared', name: 'shared' },
        { full_name: 'dest-two/shared', name: 'shared' }
      ] })
    }
    if (path === '/api/v1/repos/dest-one/shared') return json({ mirror: true, original_url: 'https://github.com/acme/shared.git' })
    if (path === '/api/v1/repos/dest-two/shared') return json({ mirror: true, original_url: 'https://github.com/other/shared.git' })
    throw new Error(`Unexpected URL ${url}`)
  }
  const mappings = await mapRepositories([
    { id: 'one', fullName: 'acme/shared', status: 'mirrored' },
    { id: 'two', fullName: 'other/shared', status: 'synced' },
    { id: 'ignored', fullName: 'third/shared', status: 'imported' }
  ], configuration, { fetch: fetchMock })
  assert.deepEqual(mappings.map(mapping => `${mapping.source.owner}/${mapping.source.repo}->${mapping.destination.owner}/${mapping.destination.repo}`), [
    'acme/shared->dest-one/shared', 'other/shared->dest-two/shared'
  ])
  assert.ok(requested.some(url => url.endsWith('/dest-two/shared')))
})

test('manual reconciliation rejects a missing deployment without creating it', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'ghark-missing-test-'))
  const root = join(parent, 'ghark')
  try {
    await assert.rejects(reconcile(root), /No ghark deployment/)
    assert.equal(existsSync(root), false)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('leaves an already enabled release unit unchanged', async () => {
  const scenario = basicScenario({ hasReleases: true })
  const result = await runReconciliation(configuration, { fetch: scenario.fetch })
  assert.equal(result.releaseUnitsEnabled, 0)
  assert.equal(result.repositoriesResynced, 0)
  assert.equal(scenario.requests.some(request => request.method === 'PATCH'), false)
  assert.equal(scenario.requests.some(request => request.url.includes('/api/job/')), false)
})

test('patches disabled units and batches IDs through sync-repo, never mirror-repo', async () => {
  const scenario = basicScenario({ hasReleases: false })
  const result = await runReconciliation(configuration, { fetch: scenario.fetch })
  assert.equal(result.releaseUnitsEnabled, 1)
  assert.equal(result.repositoriesResynced, 1)
  const sync = scenario.requests.find(request => request.url.endsWith('/api/job/sync-repo'))
  assert.ok(sync)
  assert.deepEqual(JSON.parse(String(sync.body)), { repositoryIds: ['mirror-1'] })
  assert.equal(scenario.requests.some(request => request.url.includes('mirror-repo')), false)
})

test('polls until release metadata appears', async () => {
  let releaseLookups = 0
  let now = 0
  const scenario = basicScenario({ hasReleases: false, releases: [{ tag_name: 'v1', assets: [] }], forgejoRelease: { id: 7, assets: [] } })
  const original = scenario.fetch
  const fetchMock: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/releases/tags/v1')) {
      releaseLookups += 1
      if (releaseLookups === 1) return json({}, 404)
    }
    return await original(input, init)
  }
  const result = await runReconciliation(configuration, {
    fetch: fetchMock, now: () => now, sleep: async milliseconds => { now += milliseconds },
    pollDeadlineMilliseconds: 100, pollIntervalMilliseconds: 10
  })
  assert.ok(releaseLookups >= 3)
  assert.equal(result.warnings.length, 0)
})

test('defers metadata polling when the Git tag is absent', async () => {
  const scenario = basicScenario({ hasReleases: false, releases: [{ tag_name: 'v1', assets: [] }], tagStatus: 404 })
  const result = await runReconciliation(configuration, { fetch: scenario.fetch })
  assert.ok(result.warnings.some(warning => warning.includes('Git tag v1')))
  assert.equal(scenario.requests.filter(request => request.url.includes('/releases/tags/v1')).length, 1)
})

test('bounds release polling and records a timeout', async () => {
  let now = 0
  const scenario = basicScenario({ hasReleases: false, releases: [{ tag_name: 'v1', assets: [] }] })
  const result = await runReconciliation(configuration, {
    fetch: scenario.fetch, now: () => now, sleep: async milliseconds => { now += milliseconds },
    pollDeadlineMilliseconds: 20, pollIntervalMilliseconds: 10
  })
  assert.ok(result.warnings.some(warning => warning.includes('Timed out')))
  assert.ok(now <= 20)
})

test('skips an exact attachment match without downloading it', async () => {
  const scenario = basicScenario({
    releases: [{ tag_name: 'v1', assets: [{ name: 'asset.bin', size: 4, url: 'https://api.github.test/assets/1' }] }],
    forgejoRelease: { id: 7, assets: [{ id: 8, name: 'asset.bin', size: 4 }] }
  })
  const result = await runReconciliation(configuration, { fetch: scenario.fetch })
  assert.equal(result.assetsSkipped, 1)
  assert.equal(scenario.requests.some(request => request.url === 'https://api.github.test/assets/1'), false)
})

test('downloads private assets from the API URL with required headers and verifies digest', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4])
  const scenario = basicScenario({
    assetBytes: bytes,
    releases: [{ tag_name: 'v1', assets: [{ name: 'asset.bin', size: 4, url: 'https://api.github.test/assets/1', browser_download_url: 'https://wrong.test/asset', digest: 'sha256:9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a' }] }],
    forgejoRelease: { id: 7, assets: [] }
  })
  const result = await runReconciliation(configuration, { fetch: scenario.fetch })
  assert.equal(result.assetsUploaded, 1)
  const download = scenario.requests.find(request => request.url === 'https://api.github.test/assets/1')
  assert.equal(download?.headers.get('accept'), 'application/octet-stream')
  assert.equal(download?.headers.get('authorization'), 'Bearer github-secret')
  assert.equal(download?.headers.get('x-github-api-version'), '2022-11-28')
  assert.equal(scenario.requests.some(request => request.url.includes('wrong.test')), false)
})

test('validates a changed asset before deleting and then uploads its replacement', async () => {
  const events: string[] = []
  const scenario = basicScenario({
    events,
    releases: [{ tag_name: 'v1', assets: [{ name: 'asset.bin', size: 4, url: 'https://api.github.test/assets/1' }] }],
    forgejoRelease: { id: 7, assets: [{ id: 8, name: 'asset.bin', size: 2 }] }
  })
  const result = await runReconciliation(configuration, { fetch: scenario.fetch })
  assert.deepEqual(events, ['download', 'delete', 'upload'])
  assert.equal(result.assetsReplaced, 1)
})

test('never deletes Forgejo data merely absent upstream and caps listing at 100', async () => {
  const scenario = basicScenario({ releases: [] })
  await runReconciliation(configuration, { fetch: scenario.fetch })
  assert.equal(scenario.requests.some(request => request.method === 'DELETE'), false)
  const listing = scenario.requests.find(request => request.url.includes('api.github.com/repos/'))
  assert.equal(new URL(listing?.url ?? '').searchParams.get('per_page'), '100')
  assert.equal(new URL(listing?.url ?? '').searchParams.get('page'), '1')
})

test('rejects size mismatches before upload and cleans temporary files', async () => {
  const directories: string[] = []
  const removed: string[] = []
  const scenario = basicScenario({
    assetBytes: new Uint8Array([1, 2]),
    releases: [{ tag_name: 'v1', assets: [{ name: 'asset.bin', size: 4, url: 'https://api.github.test/assets/1' }] }],
    forgejoRelease: { id: 7, assets: [] }
  })
  await assert.rejects(runReconciliation(configuration, {
    fetch: scenario.fetch,
    makeTemporaryDirectory: () => {
      const directory = mkdtempSync(join(tmpdir(), 'ghark-reconcile-test-'))
      directories.push(directory)
      return directory
    },
    removeTemporaryDirectory: directory => { removed.push(directory); rmSync(directory, { recursive: true, force: true }) }
  }), /size mismatch/)
  assert.deepEqual(removed, directories)
  assert.equal(directories.every(directory => !existsSync(directory)), true)
  assert.equal(scenario.requests.some(request => request.method === 'POST' && request.url.includes('/assets')), false)
})

test('cleans temporary files when upload fails', async () => {
  const directories: string[] = []
  const scenario = basicScenario({
    uploadStatus: 500,
    releases: [{ tag_name: 'v1', assets: [{ name: 'asset.bin', size: 4, url: 'https://api.github.test/assets/1' }] }],
    forgejoRelease: { id: 7, assets: [] }
  })
  await assert.rejects(runReconciliation(configuration, {
    fetch: scenario.fetch,
    makeTemporaryDirectory: () => {
      const directory = mkdtempSync(join(tmpdir(), 'ghark-reconcile-test-'))
      directories.push(directory)
      return directory
    }
  }), /asset upload failed/)
  assert.equal(directories.every(directory => !existsSync(directory)), true)
})

test('redacts secrets in thrown and persisted reconciliation errors', async () => {
  assert.equal(sanitizeReconciliationError(new Error('Bearer abcdef and private-value'), ['private-value']), 'Bearer [REDACTED] and [REDACTED]')
  const root = mkdtempSync(join(tmpdir(), 'ghark-state-test-'))
  try {
    writeAtomic(join(root, '.env'), serializeEnv({
      ADMIN_EMAIL: configuration.administratorEmail,
      ADMIN_PASSWORD: configuration.administratorPassword,
      FORGEJO_TOKEN: configuration.forgejoToken,
      GITHUB_TOKEN: configuration.githubToken
    }), 0o600)
    writeJson(join(root, 'deployment.json'), { ports: { mirror: 4321, forgejoHttp: 3000 } })
    await assert.rejects(reconcileUnlocked(root, {
      fetch: async () => { throw new Error(`request exposed ${configuration.githubToken}`) }
    }), /\[REDACTED\]/)
    const state = readFileSync(join(root, 'reconcile-state.json'), 'utf8')
    assert.equal(state.includes(configuration.githubToken), false)
    assert.match(state, /\[REDACTED\]/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('honors Retry-After without an unbounded GitHub retry loop', async () => {
  let attempts = 0
  const sleeps: number[] = []
  const scenario = basicScenario()
  const fetchMock: typeof fetch = async (input, init) => {
    if (String(input).includes('api.github.com/repos/')) {
      attempts += 1
      if (attempts < 3) return json({}, 429, { 'Retry-After': '2' })
    }
    return await scenario.fetch(input, init)
  }
  await runReconciliation(configuration, { fetch: fetchMock, sleep: async milliseconds => { sleeps.push(milliseconds) } })
  assert.equal(attempts, 3)
  assert.deepEqual(sleeps, [2_000, 2_000])
})
