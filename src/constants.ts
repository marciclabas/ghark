import { readFileSync } from 'node:fs'

const packageManifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { name?: string, version?: string }

export const PACKAGE_NAME = '@marciclabas/ghark'
if (packageManifest.name !== PACKAGE_NAME || !packageManifest.version) {
  throw new Error(`Cannot read ${PACKAGE_NAME} version from package.json`)
}
export const PACKAGE_VERSION = packageManifest.version
export const SCHEMA_VERSION = 1

export const images = {
  forgejo: 'codeberg.org/forgejo/forgejo:16.0.3',
  mirror: 'ghcr.io/raylabshq/gitea-mirror:v3.28.0',
  restic: 'restic/restic:0.19.1'
} as const

export const defaults = {
  forgejoHttpPort: 7331,
  forgejoSshPort: 2222,
  mirrorPort: 4321,
  mirrorInterval: '1h',
  backupTime: '03:17',
  keepDaily: 7,
  keepWeekly: 4,
  keepMonthly: 12
} as const

export const services = ['forgejo', 'gitea-mirror'] as const
export type Service = typeof services[number]
