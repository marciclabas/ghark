import { readFileSync } from 'node:fs'
import { parseEnv, serializeEnv } from './env.js'
import { writeAtomic } from './files.js'
import { dockerCompose } from './process.js'
import { deploymentFiles } from './paths.js'

async function waitFor(url: string, label: string, timeoutMilliseconds = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // The service is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
  throw new Error(`${label} did not become healthy within ${timeoutMilliseconds / 1000} seconds`)
}

function extractAccessToken(output: string): string {
  const candidates = output.match(/(?:Access token:\s*)?([A-Za-z0-9_-]{32,})/g) ?? []
  const token = candidates.at(-1)?.replace(/^Access token:\s*/, '')
  if (!token) throw new Error('Forgejo did not return an access token')
  return token
}

export async function provision(root: string): Promise<void> {
  const files = deploymentFiles(root)
  const values = parseEnv(readFileSync(files.env, 'utf8'))
  const forgejoUrl = `http://127.0.0.1:${values.FORGEJO_HTTP_PORT}`
  const mirrorUrl = `http://127.0.0.1:${values.MIRROR_PORT}`

  dockerCompose(root, ['up', '--detach', 'forgejo'])
  await waitFor(`${forgejoUrl}/api/healthz`, 'Forgejo')

  const userList = dockerCompose(root, [
    'exec', '--no-TTY', '--user', 'git', 'forgejo',
    'forgejo', 'admin', 'user', 'list'
  ], { allowFailure: true, quiet: true })

  if (!userList.includes(values.ADMIN_USERNAME ?? '')) {
    const output = dockerCompose(root, [
      'exec', '--no-TTY', '--user', 'git', 'forgejo', 'sh', '-ec',
      'forgejo admin user create --username "$ADMIN_USERNAME" --email "$ADMIN_EMAIL" --password "$ADMIN_PASSWORD" --admin --must-change-password=false --access-token --access-token-name ghark --access-token-scopes write:repository,write:issue,write:organization,write:user'
    ], { quiet: true })
    values.FORGEJO_TOKEN = extractAccessToken(output)
    writeAtomic(files.env, serializeEnv(values), 0o600)
  }

  if (!values.FORGEJO_TOKEN) throw new Error('Forgejo is provisioned but its ghark token is unavailable')
  dockerCompose(root, ['up', '--detach', '--force-recreate', 'gitea-mirror'])
  await waitFor(`${mirrorUrl}/api/health`, 'Gitea Mirror')

  const signup = await fetch(`${mirrorUrl}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: mirrorUrl
    },
    body: JSON.stringify({
      name: values.ADMIN_USERNAME,
      email: values.ADMIN_EMAIL,
      password: values.ADMIN_PASSWORD
    })
  })
  if (!signup.ok) {
    const detail = await signup.text()
    const alreadyExists = signup.status === 409 || (signup.status === 422 && /already|exist|registered/i.test(detail))
    if (!alreadyExists) throw new Error(`Could not provision Gitea Mirror administrator (${signup.status}): ${detail}`)
  }

  dockerCompose(root, ['restart', 'gitea-mirror'])
  await waitFor(`${mirrorUrl}/api/health`, 'Gitea Mirror')
}
