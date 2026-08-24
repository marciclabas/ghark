export const PACKAGE_NAME = 'ghark'
export const PACKAGE_VERSION = '0.1.0'
export const SCHEMA_VERSION = 1

export const images = {
  forgejo: 'codeberg.org/forgejo/forgejo:16.0.3',
  mirror: 'ghcr.io/raylabshq/gitea-mirror:v3.28.0',
  restic: 'restic/restic:0.19.1'
} as const

export const defaults = {
  forgejoHttpPort: 3000,
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
