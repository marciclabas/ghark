import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { deploymentFiles } from './paths.js'
import { privileged, runCapture } from './process.js'
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

export function removeTimer(stopActiveBackup = false): void {
  const service = '/etc/systemd/system/ghark-backup.service'
  const timer = '/etc/systemd/system/ghark-backup.timer'
  const hasService = existsSync(service)
  const hasTimer = existsSync(timer)
  if (!hasService && !hasTimer) {
    console.log('Automatic backup timer is not installed.')
    return
  }

  if (hasTimer) privileged('systemctl', ['disable', '--now', 'ghark-backup.timer'])
  if (hasService && stopActiveBackup) privileged('systemctl', ['stop', 'ghark-backup.service'])
  privileged('rm', ['-f', service, timer])
  privileged('systemctl', ['daemon-reload'])
  console.log('Removed automatic backup timer.')
}

export function timerStatus(): { installed: boolean, details: string } {
  const service = '/etc/systemd/system/ghark-backup.service'
  const timer = '/etc/systemd/system/ghark-backup.timer'
  if (!existsSync(service) && !existsSync(timer)) return { installed: false, details: '' }
  try {
    const details = runCapture('systemctl', [
      'show', 'ghark-backup.timer',
      '--property=ActiveState,UnitFileState,LastTriggerUSec,NextElapseUSecRealtime'
    ], { allowFailure: true, quiet: true }).trim()
    return { installed: true, details }
  } catch (error) {
    return { installed: true, details: `Could not query systemd: ${error instanceof Error ? error.message : String(error)}` }
  }
}
