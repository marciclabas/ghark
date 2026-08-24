import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { runCapture } from './process.js'
import type { UserContext } from './types.js'

export function resolveUserContext(env: NodeJS.ProcessEnv = process.env): UserContext {
  const sudoUser = env.SUDO_USER
  if (sudoUser && sudoUser !== 'root') {
    const record = runCapture('getent', ['passwd', sudoUser], { allowFailure: true }).trim()
    const fields = record.split(':')
    if (fields.length >= 7) {
      return {
        username: sudoUser,
        uid: Number(fields[2]),
        gid: Number(fields[3]),
        home: fields[5] ?? `/home/${sudoUser}`
      }
    }
    throw new Error(`Could not resolve SUDO_USER ${sudoUser}`)
  }

  const info = userInfo()
  return {
    username: info.username,
    uid: info.uid,
    gid: info.gid,
    home: env.GHARK_TEST_HOME ?? homedir()
  }
}

export function deploymentPath(user = resolveUserContext()): string {
  return join(user.home, 'ghark')
}

export function deploymentFiles(root: string) {
  return {
    root,
    compose: join(root, 'compose.yaml'),
    env: join(root, '.env'),
    manifest: join(root, 'deployment.json'),
    lock: join(dirname(root), '.ghark-operation.lock'),
    backupState: join(root, 'backup-state.json'),
    reconcileState: join(root, 'reconcile-state.json'),
    verifyState: join(root, 'verification-state.json'),
    data: join(root, 'data'),
    cli: join(root, '.cli'),
    systemd: join(root, 'systemd')
  }
}
