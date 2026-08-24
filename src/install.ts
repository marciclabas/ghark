import { existsSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGE_NAME, PACKAGE_VERSION } from './constants.js'
import { writeAtomic } from './files.js'
import { deploymentFiles } from './paths.js'
import { run } from './process.js'
import { renderPinnedPackage } from './templates.js'
import type { UserContext } from './types.js'

export function installPinnedCli(root: string, user: UserContext): void {
  if (process.env.GHARK_SKIP_SELF_INSTALL === '1') return
  const files = deploymentFiles(root)
  mkdirSync(files.cli, { recursive: true })
  writeAtomic(join(files.cli, 'package.json'), renderPinnedPackage())
  const source = process.env.GHARK_PACKAGE_SOURCE ?? `${PACKAGE_NAME}@${PACKAGE_VERSION}`
  run('npm', ['install', '--omit=dev', '--save-exact', '--prefix', files.cli, source])

  const binDirectory = join(user.home, '.local', 'bin')
  const launcher = join(binDirectory, 'ghark')
  mkdirSync(binDirectory, { recursive: true })
  if (existsSync(launcher)) unlinkSync(launcher)
  symlinkSync(join(files.cli, 'node_modules', '.bin', 'ghark'), launcher)
  if (process.getuid?.() === 0 && user.uid !== 0) {
    const owner = `${user.uid}:${user.gid}`
    run('chown', ['-R', owner, files.cli])
    run('chown', [owner, binDirectory])
    run('chown', ['-h', owner, launcher])
  }
  console.log(`Installed launcher: ${launcher}`)
}
