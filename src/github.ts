import { commandExists, runCapture } from './process.js'
import { promptConfirm, promptSecret } from './prompts.js'
import type { GitHubIdentity } from './types.js'

type GitHubUser = {
  login?: string
}

type GitHubOrganization = {
  login?: string
}

async function githubRequest(token: string, path: string): Promise<Response> {
  return await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'ghark',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  })
}

export async function validateGitHubToken(token: string): Promise<GitHubIdentity> {
  const response = await githubRequest(token, '/user')
  if (!response.ok) throw new Error(`GitHub rejected the credential (${response.status})`)
  const user = await response.json() as GitHubUser
  if (!user.login) throw new Error('GitHub did not return an account login')

  const scopes = (response.headers.get('x-oauth-scopes') ?? '')
    .split(',')
    .map(scope => scope.trim())
    .filter(Boolean)
  if (scopes.length > 0) {
    const canReadRepositories = scopes.includes('repo')
    const canReadOrganizations = scopes.includes('read:org') || scopes.includes('admin:org')
    if (!canReadRepositories || !canReadOrganizations) {
      throw new Error('The GitHub token requires repo and read:org scopes')
    }
  }

  const organizations: string[] = []
  for (let page = 1; ; page += 1) {
    const orgResponse = await githubRequest(token, `/user/orgs?per_page=100&page=${page}`)
    if (!orgResponse.ok) throw new Error(`Could not list GitHub organizations (${orgResponse.status})`)
    const batch = await orgResponse.json() as GitHubOrganization[]
    organizations.push(...batch.flatMap(org => org.login ? [org.login] : []))
    if (batch.length < 100) break
  }

  return { login: user.login, token, scopes, organizations: organizations.sort() }
}

export async function acquireGitHubIdentity(): Promise<GitHubIdentity> {
  if (commandExists('gh')) {
    const token = runCapture('gh', ['auth', 'token', '--hostname', 'github.com'], {
      allowFailure: true,
      quiet: true
    }).trim()
    if (token) {
      try {
        const identity = await validateGitHubToken(token)
        if (await promptConfirm(`Use GitHub CLI account ${identity.login}?`, true)) return identity
      } catch (error) {
        console.warn(`GitHub CLI credential cannot be used: ${messageOf(error)}`)
      }
    }
  }

  console.log('Create a classic GitHub token with repo and read:org scopes.')
  while (true) {
    const token = await promptSecret('GitHub token')
    try {
      return await validateGitHubToken(token)
    } catch (error) {
      console.error(messageOf(error))
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
