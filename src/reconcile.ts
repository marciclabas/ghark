import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdtempSync, openAsBlob, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parseEnv, redact } from './env.js'
import { writeJson } from './files.js'
import { withOperationLock } from './lock.js'
import { deploymentFiles } from './paths.js'
import type { DeploymentManifest, ReconcileResult, ReconcileState } from './types.js'

type MirrorRepository = {
  id?: string
  fullName?: string
  mirroredLocation?: string
  status?: string
}

export type RepositoryMapping = {
  mirrorRepositoryId: string
  source: { owner: string, repo: string }
  destination: { owner: string, repo: string }
}

type ForgejoRepository = {
  full_name?: string
  name?: string
  owner?: { login?: string }
  mirror?: boolean
  original_url?: string
  has_releases?: boolean
}

type GitHubAsset = {
  id?: number
  name?: string
  size?: number
  url?: string
  digest?: string | null
}

type GitHubRelease = {
  tag_name?: string
  assets?: GitHubAsset[]
}

type ForgejoAsset = {
  id?: number
  name?: string
  size?: number
}

type ForgejoRelease = {
  id?: number
  tag_name?: string
  assets?: ForgejoAsset[]
}

export type ReconcileConfiguration = {
  mirrorUrl: string
  forgejoUrl: string
  administratorEmail: string
  administratorPassword: string
  forgejoToken: string
  githubToken: string
}

export type ReconcileDependencies = {
  fetch: typeof fetch
  now: () => number
  sleep: (milliseconds: number) => Promise<void>
  makeTemporaryDirectory: () => string
  removeTemporaryDirectory: (path: string) => void
  pollDeadlineMilliseconds: number
  pollIntervalMilliseconds: number
}

const defaultDependencies: ReconcileDependencies = {
  fetch: globalThis.fetch,
  now: Date.now,
  sleep: async milliseconds => await new Promise(resolve => setTimeout(resolve, milliseconds)),
  makeTemporaryDirectory: () => mkdtempSync(join(tmpdir(), 'ghark-reconcile-')),
  removeTemporaryDirectory: path => rmSync(path, { recursive: true, force: true }),
  pollDeadlineMilliseconds: 5 * 60 * 1000,
  pollIntervalMilliseconds: 5_000
}

const liveStatuses = new Set(['mirrored', 'synced', 'syncing', 'archived'])
const retainedDestinationStatuses = new Set(['failed', 'mirroring'])

function splitRepository(value: string | undefined): { owner: string, repo: string } | undefined {
  const parts = value?.trim().split('/')
  if (parts?.length !== 2 || !parts[0] || !parts[1]) return undefined
  return { owner: parts[0], repo: parts[1] }
}

function repositoryPath(repository: { owner: string, repo: string }): string {
  return `${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`
}

function sourceFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.hostname.toLowerCase() !== 'github.com') return undefined
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/')
    if (parts.length < 2) return undefined
    return `${parts.at(-2)}/${parts.at(-1)}`.toLowerCase()
  } catch {
    return undefined
  }
}

function endpointError(service: string, operation: string, status: number, repository?: string, asset?: string): Error {
  const context = [repository, asset].filter(Boolean).join(' asset ')
  return new Error(`${service} ${operation} failed (${status})${context ? ` for ${context}` : ''}`)
}

async function forgejoRequest(
  configuration: ReconcileConfiguration,
  dependencies: ReconcileDependencies,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `token ${configuration.forgejoToken}`)
  return await dependencies.fetch(`${configuration.forgejoUrl}${path}`, { ...init, headers })
}

function retryDelay(response: Response, now: number): number {
  const retryAfter = response.headers.get('retry-after')
  if (!retryAfter) {
    const resetSeconds = Number(response.headers.get('x-ratelimit-reset'))
    return Number.isFinite(resetSeconds) ? Math.max(0, resetSeconds * 1_000 - now) : 1_000
  }
  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000)
  const date = Date.parse(retryAfter)
  return Number.isFinite(date) ? Math.max(0, date - now) : 1_000
}

async function githubRequest(
  configuration: ReconcileConfiguration,
  dependencies: ReconcileDependencies,
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${configuration.githubToken}`)
    headers.set('X-GitHub-Api-Version', '2022-11-28')
    headers.set('Accept', headers.get('Accept') ?? 'application/vnd.github+json')
    const response = await dependencies.fetch(url, { ...init, headers })
    if (![403, 429].includes(response.status) || attempt === 2) return response
    await response.body?.cancel()
    await dependencies.sleep(retryDelay(response, dependencies.now()))
  }
  throw new Error('GitHub retry loop ended unexpectedly')
}

async function resolveDestination(
  record: MirrorRepository,
  source: { owner: string, repo: string },
  configuration: ReconcileConfiguration,
  dependencies: ReconcileDependencies
): Promise<{ owner: string, repo: string } | undefined> {
  const recorded = splitRepository(record.mirroredLocation)
  if (recorded) return recorded

  const response = await forgejoRequest(
    configuration,
    dependencies,
    `/api/v1/repos/search?q=${encodeURIComponent(source.repo)}&limit=50`
  )
  if (!response.ok) throw endpointError('Forgejo', 'repository search', response.status, `${source.owner}/${source.repo}`)
  const payload = await response.json() as { data?: ForgejoRepository[] }
  const candidates = (payload.data ?? []).filter(candidate => candidate.name?.toLowerCase() === source.repo.toLowerCase())
  for (const candidate of candidates) {
    const fullName = candidate.full_name ?? (candidate.owner?.login && candidate.name ? `${candidate.owner.login}/${candidate.name}` : undefined)
    const destination = splitRepository(fullName)
    if (!destination) continue
    let detail = candidate
    if (detail.original_url === undefined || detail.mirror === undefined) {
      const detailResponse = await forgejoRequest(configuration, dependencies, `/api/v1/repos/${repositoryPath(destination)}`)
      if (!detailResponse.ok) continue
      detail = await detailResponse.json() as ForgejoRepository
    }
    if (detail.mirror === true && sourceFromUrl(detail.original_url) === `${source.owner}/${source.repo}`.toLowerCase()) return destination
  }
  return undefined
}

export async function mapRepositories(
  records: MirrorRepository[],
  configuration: ReconcileConfiguration,
  overrides: Partial<ReconcileDependencies> = {}
): Promise<RepositoryMapping[]> {
  const dependencies = { ...defaultDependencies, ...overrides }
  const mappings: RepositoryMapping[] = []
  for (const record of records) {
    const source = splitRepository(record.fullName)
    const explicitDestination = splitRepository(record.mirroredLocation)
    const hasLiveStatus = record.status !== undefined && liveStatuses.has(record.status)
    const retainedDestination = record.status !== undefined
      && retainedDestinationStatuses.has(record.status)
      && explicitDestination !== undefined
    if (!record.id || !source || (!hasLiveStatus && !retainedDestination)) continue
    const destination = await resolveDestination(record, source, configuration, dependencies)
    if (!destination) continue
    mappings.push({ mirrorRepositoryId: record.id, source, destination })
  }
  return mappings
}

function cookieHeader(headers: Headers): string {
  const values = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
    ?? (headers.get('set-cookie') ? [headers.get('set-cookie') as string] : [])
  return values.map(value => value.split(';', 1)[0]).filter(Boolean).join('; ')
}

async function authenticateMirror(configuration: ReconcileConfiguration, dependencies: ReconcileDependencies): Promise<HeadersInit> {
  const response = await dependencies.fetch(`${configuration.mirrorUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: configuration.mirrorUrl },
    body: JSON.stringify({ email: configuration.administratorEmail, password: configuration.administratorPassword })
  })
  if (!response.ok) throw endpointError('Gitea Mirror', 'sign-in', response.status)
  const cookie = cookieHeader(response.headers)
  if (!cookie) throw new Error('Gitea Mirror sign-in returned no session cookie')
  return { Cookie: cookie, Origin: configuration.mirrorUrl }
}

async function listGitHubReleases(
  mapping: RepositoryMapping,
  configuration: ReconcileConfiguration,
  dependencies: ReconcileDependencies
): Promise<GitHubRelease[]> {
  const source = repositoryPath(mapping.source)
  const response = await githubRequest(
    configuration,
    dependencies,
    `https://api.github.com/repos/${source}/releases?per_page=100&page=1`
  )
  if (!response.ok) throw endpointError('GitHub', 'release listing', response.status, `${mapping.source.owner}/${mapping.source.repo}`)
  const releases = await response.json() as GitHubRelease[]
  return releases.slice(0, 100)
}

async function forgejoReleaseByTag(
  mapping: RepositoryMapping,
  tag: string,
  configuration: ReconcileConfiguration,
  dependencies: ReconcileDependencies
): Promise<ForgejoRelease | undefined> {
  const response = await forgejoRequest(
    configuration,
    dependencies,
    `/api/v1/repos/${repositoryPath(mapping.destination)}/releases/tags/${encodeURIComponent(tag)}`
  )
  if (response.status === 404) return undefined
  if (!response.ok) throw endpointError('Forgejo', 'release lookup', response.status, `${mapping.destination.owner}/${mapping.destination.repo}`)
  return await response.json() as ForgejoRelease
}

async function pollChangedRepositories(
  mappings: RepositoryMapping[],
  releases: Map<string, GitHubRelease[]>,
  configuration: ReconcileConfiguration,
  dependencies: ReconcileDependencies,
  result: ReconcileResult
): Promise<void> {
  const expected: Array<{ mapping: RepositoryMapping, tag: string }> = []
  for (const mapping of mappings) {
    for (const release of releases.get(mapping.mirrorRepositoryId) ?? []) {
      if (!release.tag_name) continue
      const tagResponse = await forgejoRequest(
        configuration,
        dependencies,
        `/api/v1/repos/${repositoryPath(mapping.destination)}/tags/${encodeURIComponent(release.tag_name)}`
      )
      if (tagResponse.status === 404) {
        result.warnings.push(`Git tag ${release.tag_name} is not present in Forgejo for ${mapping.source.owner}/${mapping.source.repo}; release deferred`)
        continue
      }
      if (!tagResponse.ok) throw endpointError('Forgejo', 'tag lookup', tagResponse.status, `${mapping.destination.owner}/${mapping.destination.repo}`)
      expected.push({ mapping, tag: release.tag_name })
    }
  }

  const pending = new Map(expected.map(item => [`${item.mapping.mirrorRepositoryId}\0${item.tag}`, item]))
  const deadline = dependencies.now() + dependencies.pollDeadlineMilliseconds
  while (pending.size > 0 && dependencies.now() < deadline) {
    for (const [key, item] of pending) {
      if (await forgejoReleaseByTag(item.mapping, item.tag, configuration, dependencies)) pending.delete(key)
    }
    if (pending.size > 0 && dependencies.now() < deadline) await dependencies.sleep(dependencies.pollIntervalMilliseconds)
  }
  for (const item of pending.values()) {
    result.warnings.push(`Timed out waiting for release ${item.tag} in Forgejo for ${item.mapping.source.owner}/${item.mapping.source.repo}`)
  }
}

async function listForgejoAssets(
  mapping: RepositoryMapping,
  release: ForgejoRelease,
  configuration: ReconcileConfiguration,
  dependencies: ReconcileDependencies
): Promise<ForgejoAsset[]> {
  if (release.assets) return release.assets
  if (release.id === undefined) throw new Error(`Forgejo release has no ID for ${mapping.destination.owner}/${mapping.destination.repo}`)
  const response = await forgejoRequest(
    configuration,
    dependencies,
    `/api/v1/repos/${repositoryPath(mapping.destination)}/releases/${release.id}/assets`
  )
  if (!response.ok) throw endpointError('Forgejo', 'asset listing', response.status, `${mapping.destination.owner}/${mapping.destination.repo}`)
  return await response.json() as ForgejoAsset[]
}

async function downloadAsset(
  mapping: RepositoryMapping,
  asset: GitHubAsset,
  directory: string,
  configuration: ReconcileConfiguration,
  dependencies: ReconcileDependencies
): Promise<string> {
  if (!asset.url || !asset.name || asset.size === undefined) throw new Error(`GitHub returned incomplete asset metadata for ${mapping.source.owner}/${mapping.source.repo}`)
  const response = await githubRequest(configuration, dependencies, asset.url, { headers: { Accept: 'application/octet-stream' } })
  if (!response.ok || !response.body) throw endpointError('GitHub', 'asset download', response.status, `${mapping.source.owner}/${mapping.source.repo}`, asset.name)
  const path = join(directory, `${crypto.randomUUID()}-${basename(asset.name)}`)
  const hash = createHash('sha256')
  const hashingStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    }
  })
  await pipeline(Readable.fromWeb(response.body as never), hashingStream, createWriteStream(path, { flags: 'wx', mode: 0o600 }))
  const size = statSync(path).size
  if (size !== asset.size) throw new Error(`Downloaded asset size mismatch for ${mapping.source.owner}/${mapping.source.repo} asset ${asset.name}`)
  const expectedDigest = asset.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase()
  if (expectedDigest && hash.digest('hex') !== expectedDigest) {
    throw new Error(`Downloaded asset digest mismatch for ${mapping.source.owner}/${mapping.source.repo} asset ${asset.name}`)
  }
  return path
}

async function uploadAsset(
  mapping: RepositoryMapping,
  releaseId: number,
  asset: GitHubAsset,
  path: string,
  configuration: ReconcileConfiguration,
  dependencies: ReconcileDependencies
): Promise<void> {
  if (!asset.name || asset.size === undefined) throw new Error('Cannot upload an asset with incomplete metadata')
  const form = new FormData()
  form.append('attachment', await openAsBlob(path), asset.name)
  const response = await forgejoRequest(
    configuration,
    dependencies,
    `/api/v1/repos/${repositoryPath(mapping.destination)}/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`,
    { method: 'POST', body: form }
  )
  if (!response.ok) throw endpointError('Forgejo', 'asset upload', response.status, `${mapping.destination.owner}/${mapping.destination.repo}`, asset.name)
  const uploaded = await response.json() as ForgejoAsset
  if (uploaded.name !== asset.name || uploaded.size !== asset.size) {
    throw new Error(`Forgejo asset verification failed for ${mapping.destination.owner}/${mapping.destination.repo} asset ${asset.name}`)
  }
}

async function reconcileAsset(
  mapping: RepositoryMapping,
  release: ForgejoRelease,
  existing: ForgejoAsset[],
  asset: GitHubAsset,
  configuration: ReconcileConfiguration,
  dependencies: ReconcileDependencies,
  result: ReconcileResult
): Promise<void> {
  if (!asset.name || asset.size === undefined || !asset.url) throw new Error(`GitHub returned incomplete asset metadata for ${mapping.source.owner}/${mapping.source.repo}`)
  const sameName = existing.find(candidate => candidate.name === asset.name)
  if (sameName?.size === asset.size) {
    result.assetsSkipped += 1
    return
  }
  if (release.id === undefined) throw new Error(`Forgejo release has no ID for ${mapping.destination.owner}/${mapping.destination.repo}`)

  const directory = dependencies.makeTemporaryDirectory()
  try {
    const path = await downloadAsset(mapping, asset, directory, configuration, dependencies)
    if (sameName) {
      if (sameName.id === undefined) throw new Error(`Forgejo attachment has no ID for ${mapping.destination.owner}/${mapping.destination.repo} asset ${asset.name}`)
      const deletion = await forgejoRequest(
        configuration,
        dependencies,
        `/api/v1/repos/${repositoryPath(mapping.destination)}/releases/${release.id}/assets/${sameName.id}`,
        { method: 'DELETE' }
      )
      if (!deletion.ok) throw endpointError('Forgejo', 'stale asset deletion', deletion.status, `${mapping.destination.owner}/${mapping.destination.repo}`, asset.name)
      await uploadAsset(mapping, release.id, asset, path, configuration, dependencies)
      result.assetsReplaced += 1
    } else {
      await uploadAsset(mapping, release.id, asset, path, configuration, dependencies)
      result.assetsUploaded += 1
    }
  } finally {
    dependencies.removeTemporaryDirectory(directory)
  }
}

async function withConcurrency<T>(items: T[], limit: number, callback: (item: T) => Promise<void>): Promise<void> {
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index]
      index += 1
      if (item !== undefined) await callback(item)
    }
  })
  const outcomes = await Promise.allSettled(workers)
  const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
  if (failure) throw failure.reason
}

export function sanitizeReconciliationError(error: unknown, secrets: string[] = []): string {
  const message = error instanceof Error ? error.message : String(error)
  return redact(message, secrets).replace(/(Bearer|token)\s+[A-Za-z0-9._~+\/-]+/gi, '$1 [REDACTED]')
}

export async function runReconciliation(
  configuration: ReconcileConfiguration,
  overrides: Partial<ReconcileDependencies> = {},
  progress?: ReconcileResult
): Promise<ReconcileResult> {
  const dependencies = { ...defaultDependencies, ...overrides }
  const started = dependencies.now()
  const result = progress ?? {
    completedAt: '', durationSeconds: 0, repositoriesScanned: 0, releaseUnitsEnabled: 0,
    repositoriesResynced: 0, releasesScanned: 0, assetsUploaded: 0, assetsReplaced: 0,
    assetsSkipped: 0, warnings: []
  }
  const mirrorHeaders = await authenticateMirror(configuration, dependencies)
  const repositoryResponse = await dependencies.fetch(`${configuration.mirrorUrl}/api/github/repositories`, { headers: mirrorHeaders })
  if (!repositoryResponse.ok) throw endpointError('Gitea Mirror', 'repository listing', repositoryResponse.status)
  const payload = await repositoryResponse.json() as { repositories?: MirrorRepository[] }
  const mappings = await mapRepositories(payload.repositories ?? [], configuration, dependencies)
  result.repositoriesScanned = mappings.length

  const changed: RepositoryMapping[] = []
  for (const mapping of mappings) {
    const path = `/api/v1/repos/${repositoryPath(mapping.destination)}`
    const response = await forgejoRequest(configuration, dependencies, path)
    if (!response.ok) throw endpointError('Forgejo', 'repository lookup', response.status, `${mapping.destination.owner}/${mapping.destination.repo}`)
    const repository = await response.json() as ForgejoRepository
    if (repository.has_releases === true) continue
    const patch = await forgejoRequest(configuration, dependencies, path, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ has_releases: true })
    })
    if (!patch.ok) throw endpointError('Forgejo', 'release unit update', patch.status, `${mapping.destination.owner}/${mapping.destination.repo}`)
    changed.push(mapping)
    result.releaseUnitsEnabled += 1
  }

  const releaseCache = new Map<string, GitHubRelease[]>()
  if (changed.length > 0) {
    const repositoryIds = [...new Set(changed.map(mapping => mapping.mirrorRepositoryId))]
    const response = await dependencies.fetch(`${configuration.mirrorUrl}/api/job/sync-repo`, {
      method: 'POST',
      headers: { ...mirrorHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repositoryIds })
    })
    if (!response.ok) throw endpointError('Gitea Mirror', 'repository sync', response.status)
    result.repositoriesResynced = repositoryIds.length
    for (const mapping of changed) releaseCache.set(mapping.mirrorRepositoryId, await listGitHubReleases(mapping, configuration, dependencies))
    await pollChangedRepositories(changed, releaseCache, configuration, dependencies, result)
  }

  for (const mapping of mappings) {
    const releases = releaseCache.get(mapping.mirrorRepositoryId) ?? await listGitHubReleases(mapping, configuration, dependencies)
    for (const githubRelease of releases) {
      result.releasesScanned += 1
      if (!githubRelease.tag_name) continue
      const forgejoRelease = await forgejoReleaseByTag(mapping, githubRelease.tag_name, configuration, dependencies)
      if (!forgejoRelease) {
        result.warnings.push(`Release ${githubRelease.tag_name} is not present in Forgejo for ${mapping.source.owner}/${mapping.source.repo}; assets deferred`)
        continue
      }
      const existing = await listForgejoAssets(mapping, forgejoRelease, configuration, dependencies)
      await withConcurrency(githubRelease.assets ?? [], 2, async asset => {
        await reconcileAsset(mapping, forgejoRelease, existing, asset, configuration, dependencies, result)
      })
    }
  }

  result.completedAt = new Date(dependencies.now()).toISOString()
  result.durationSeconds = Math.round((dependencies.now() - started) / 1000)
  return result
}

function configurationFromDeployment(root: string): { configuration: ReconcileConfiguration, secrets: string[] } {
  const files = deploymentFiles(root)
  const values = parseEnv(readFileSync(files.env, 'utf8'))
  const manifest = JSON.parse(readFileSync(files.manifest, 'utf8')) as DeploymentManifest
  const required = ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'FORGEJO_TOKEN', 'GITHUB_TOKEN'] as const
  for (const key of required) if (!values[key]) throw new Error(`Deployment environment is missing ${key}`)
  return {
    configuration: {
      mirrorUrl: `http://127.0.0.1:${manifest.ports.mirror}`,
      forgejoUrl: `http://127.0.0.1:${manifest.ports.forgejoHttp}`,
      administratorEmail: values.ADMIN_EMAIL as string,
      administratorPassword: values.ADMIN_PASSWORD as string,
      forgejoToken: values.FORGEJO_TOKEN as string,
      githubToken: values.GITHUB_TOKEN as string
    },
    secrets: required.flatMap(key => values[key] ? [values[key]] : [])
  }
}

export async function reconcileUnlocked(root: string, overrides: Partial<ReconcileDependencies> = {}): Promise<ReconcileResult> {
  const files = deploymentFiles(root)
  const dependencies = { ...defaultDependencies, ...overrides }
  const started = dependencies.now()
  const progress: ReconcileResult = {
    completedAt: '', durationSeconds: 0, repositoriesScanned: 0, releaseUnitsEnabled: 0,
    repositoriesResynced: 0, releasesScanned: 0, assetsUploaded: 0, assetsReplaced: 0,
    assetsSkipped: 0, warnings: []
  }
  let secrets: string[] = []
  try {
    const deployment = configurationFromDeployment(root)
    secrets = deployment.secrets
    const result = await runReconciliation(deployment.configuration, dependencies, progress)
    writeJson(files.reconcileState, { ...result, success: true } satisfies ReconcileState)
    return result
  } catch (error) {
    progress.completedAt = new Date(dependencies.now()).toISOString()
    progress.durationSeconds = Math.round((dependencies.now() - started) / 1000)
    const sanitized = sanitizeReconciliationError(error, secrets)
    writeJson(files.reconcileState, { ...progress, success: false, error: sanitized } satisfies ReconcileState)
    throw new Error(sanitized)
  }
}

export async function reconcile(root: string): Promise<ReconcileResult> {
  const files = deploymentFiles(root)
  if (!existsSync(files.manifest)) throw new Error(`No ghark deployment found at ${root}`)
  return await withOperationLock(files.lock, 'reconcile', async () => {
    const result = await reconcileUnlocked(root)
    console.log(`Reconciliation complete: ${result.repositoriesScanned} repositories, ${result.assetsUploaded} assets uploaded, ${result.assetsReplaced} replaced`)
    return result
  })
}
