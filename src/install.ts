import { existsSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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

export function removePinnedCli(root: string, user: UserContext): void {
  const launcher = join(user.home, '.local', 'bin', 'ghark')
  let target: string
  try {
    target = readlinkSync(launcher)
  } catch {
    if (existsSync(launcher)) console.warn(`Kept ${launcher} because it is not ghark's managed symlink.`)
    return
  }

  const installedBinary = join(root, '.cli', 'node_modules', '.bin', 'ghark')
  if (resolve(dirname(launcher), target) !== resolve(installedBinary)) {
    console.warn(`Kept ${launcher} because it points outside this ghark deployment.`)
    return
  }
  unlinkSync(launcher)
  console.log(`Removed launcher: ${launcher}`)
}
