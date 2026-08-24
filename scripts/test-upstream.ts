import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { writeAtomic } from '../src/files.js'
import { dockerCompose, privileged } from '../src/process.js'
import { provision } from '../src/provision.js'
import { renderCompose, renderEnvironment } from '../src/templates.js'
import type { InitAnswers, UserContext } from '../src/types.js'

const root = mkdtempSync(join(tmpdir(), 'ghark-upstream-'))
process.env.GHARK_COMPOSE_PROJECT = `ghark-upstream-test-${process.pid}`

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
  adminPassword: 'ghark-upstream-test-password',
  github: { login: 'ghark-test', token: 'invalid-test-token', scopes: [], organizations: [] },
  includePersonal: false,
  organizations: ['ghark-test-org'],
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
  writeAtomic(join(root, '.env'), renderEnvironment(answers, user), 0o600)
  await provision(root)

  const forgejo = await fetch(`http://127.0.0.1:${forgejoHttpPort}/api/healthz`)
  const mirror = await fetch(`http://127.0.0.1:${mirrorPort}/api/health`)
  if (!forgejo.ok || !mirror.ok) throw new Error('An upstream health check failed after provisioning')

  const mirrorUrl = `http://127.0.0.1:${mirrorPort}`
  const signIn = await fetch(`${mirrorUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: mirrorUrl },
    body: JSON.stringify({ email: answers.adminEmail, password: answers.adminPassword })
  })
  if (!signIn.ok) throw new Error(`Shared administrator sign-in failed (${signIn.status}): ${await signIn.text()}`)
  const cookie = signIn.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const config = await fetch(`${mirrorUrl}/api/config`, { headers: { Cookie: cookie, Origin: mirrorUrl } })
  if (!config.ok) throw new Error(`Configuration read failed (${config.status}): ${await config.text()}`)
  const serializedConfig = JSON.stringify(await config.json())
  if (!serializedConfig.includes('ghark-test-org') || !serializedConfig.includes('skipPersonalRepos')) {
    throw new Error('Environment organization policy was not persisted for the administrator')
  }
  console.log('Pinned Forgejo and Gitea Mirror provisioning passed.')
} finally {
  dockerCompose(root, ['down', '--volumes'], { allowFailure: true })
  privileged('chown', ['-R', `${user.uid}:${user.gid}`, root])
  rmSync(root, { recursive: true, force: true })
}
