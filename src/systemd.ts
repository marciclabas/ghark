import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { deploymentFiles } from './paths.js'
import { privileged } from './process.js'
import { renderSystemdService, renderSystemdTimer } from './templates.js'
import { writeAtomic } from './files.js'
import type { UserContext } from './types.js'

export function installTimer(root: string, backupTime: string, user: UserContext): void {
  const files = deploymentFiles(root)
  mkdirSync(files.systemd, { recursive: true })
  const service = join(files.systemd, 'ghark-backup.service')
  const timer = join(files.systemd, 'ghark-backup.timer')
  writeAtomic(service, renderSystemdService(root, user))
  writeAtomic(timer, renderSystemdTimer(backupTime))
  privileged('install', ['-m', '0644', service, '/etc/systemd/system/ghark-backup.service'])
  privileged('install', ['-m', '0644', timer, '/etc/systemd/system/ghark-backup.timer'])
  privileged('systemctl', ['daemon-reload'])
  privileged('systemctl', ['enable', '--now', 'ghark-backup.timer'])
}
