#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { backup, BackupCancelledError, backupStatus } from './backup.js'
import { configureBackup, configureGitHub } from './configure.js'
import { PACKAGE_VERSION } from './constants.js'
import { initialize } from './init.js'
import {
  down,
  failoverGuide,
  logs,
  snapshots,
  status,
  stopSync,
  up,
  update,
  verify
} from './operations.js'
import { deploymentFiles, deploymentPath, resolveUserContext } from './paths.js'
import { PromptCancelledError } from './prompts.js'
import { restore } from './restore.js'
import { reconcile } from './reconcile.js'
import { installTimer, removeTimer } from './systemd.js'
import type { DeploymentManifest } from './types.js'

const help = `ghark ${PACKAGE_VERSION} — Your GitHub repositories, safely aboard.

Usage: ghark <command>

Commands:
  init                     Create or reconcile ~/ghark
  up                       Pull pinned images and start services
  down                     Stop services without deleting data
  status                   Show services, endpoints, timer, and latest backup
  logs [service]           Show the latest redacted service logs
  configure github         Change the GitHub identity and organization selection
  configure backup         Change S3/restic credentials
  backup [action]          Run backups and manage automatic scheduling
  reconcile                Reconcile releases and private release assets
  snapshots                List restic snapshots
  verify [--full]          Verify Compose and the restic repository
  restore [snapshot]       Restore a snapshot; defaults to latest
  update                   Back up and install the latest compatible release
  stop-sync                Stop GitHub synchronization for failover
  failover-guide           Print the manual promotion procedure
  install-timer            Compatibility alias for backup install
  version                  Print the ghark version
  help                     Show this help
`

const backupHelp = `Usage: ghark backup <start|install|uninstall|status>

Create an encrypted restic snapshot, apply retention, and verify the repository.
The backup runs in the foreground and reports each stage. Press Ctrl+C once to
cancel the active step; ghark will still attempt to restore services that were
running before the backup.

Commands:
  ghark backup              Show this help
  ghark backup start        Start a foreground backup
  ghark backup install      Install or repair automatic backup scheduling
  ghark backup uninstall    Remove automatic scheduling; keep all backup data
  ghark backup status       Show timer state and the latest backup result
  ghark backup --help       Show this help
`

async function main(): Promise<void> {
  const [command = 'help', argument, ...flags] = process.argv.slice(2)
  const user = resolveUserContext()
  const root = deploymentPath(user)

  switch (command) {
    case 'init':
      await initialize()
      return
    case 'up':
      up(root)
      return
    case 'down':
      down(root)
      return
    case 'status':
      status(root)
      return
    case 'logs':
      logs(root, argument)
      return
    case 'configure':
      if (argument === 'github') await configureGitHub(root)
      else if (argument === 'backup') await configureBackup(root)
      else throw new Error('Use ghark configure github or ghark configure backup')
      return
    case 'backup':
      if (!argument || argument === '--help' || argument === '-h' || flags.includes('--help') || flags.includes('-h')) {
        console.log(backupHelp)
        return
      }
      switch (argument) {
        case 'start':
          await backup(root)
          return
        case 'install': {
          const manifest = JSON.parse(readFileSync(deploymentFiles(root).manifest, 'utf8')) as DeploymentManifest
          installTimer(root, manifest.backupTime, user)
          console.log('Automatic backup scheduling installed.')
          return
        }
        case 'uninstall':
          removeTimer()
          return
        case 'status':
          backupStatus(root)
          return
        default:
          throw new Error(`Unknown backup action: ${argument}\n\n${backupHelp}`)
      }
    case 'reconcile':
      await reconcile(root)
      return
    case 'snapshots':
      snapshots(root)
      return
    case 'verify':
      verify(root, argument === '--full' || flags.includes('--full'))
      return
    case 'restore':
      await restore(argument && !argument.startsWith('-') ? argument : undefined)
      return
    case 'update':
      await update(root)
      return
    case 'stop-sync':
      stopSync(root)
      return
    case 'failover-guide':
      failoverGuide(root)
      return
    case 'install-timer': {
      const manifest = JSON.parse(readFileSync(deploymentFiles(root).manifest, 'utf8')) as DeploymentManifest
      installTimer(root, manifest.backupTime, user)
      console.log('Automatic backup scheduling installed.')
      return
    }
    case 'version':
    case '--version':
    case '-v':
      console.log(PACKAGE_VERSION)
      return
    case 'help':
    case '--help':
    case '-h':
      console.log(help)
      return
    default:
      throw new Error(`Unknown command: ${command}\n\n${help}`)
  }
}

main().catch(error => {
  if (error instanceof BackupCancelledError) {
    console.error('Backup cancelled. Previously running services were restored where possible.')
    process.exitCode = 130
    return
  }
  if (error instanceof PromptCancelledError) {
    process.exitCode = 1
    return
  }
  console.error(`ghark: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
