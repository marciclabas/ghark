#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { backup } from './backup.js'
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
import { restore } from './restore.js'
import { reconcile } from './reconcile.js'
import { installTimer } from './systemd.js'
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
  backup                   Create, retain, and verify a snapshot
  reconcile                Reconcile releases and private release assets
  snapshots                List restic snapshots
  verify [--full]          Verify Compose and the restic repository
  restore [snapshot]       Restore a snapshot; defaults to latest
  update                   Back up and install the latest compatible release
  stop-sync                Stop GitHub synchronization for failover
  failover-guide           Print the manual promotion procedure
  install-timer            Install or repair the systemd timer
  version                  Print the ghark version
  help                     Show this help
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
      await backup(root)
      return
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
  console.error(`ghark: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
