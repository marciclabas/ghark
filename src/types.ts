export type UserContext = {
  username: string
  uid: number
  gid: number
  home: string
}

export type GitHubIdentity = {
  login: string
  token: string
  scopes: string[]
  organizations: string[]
}

export type S3Config = {
  endpoint: string
  region: string
  bucket: string
  prefix: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
  resticPassword: string
}

export type InitAnswers = {
  adminUsername: string
  adminEmail: string
  adminPassword: string
  github: GitHubIdentity
  includePersonal: boolean
  organizations: string[]
  s3: S3Config
  forgejoHttpPort: number
  forgejoSshPort: number
  mirrorPort: number
  backupTime: string
}

export type DeploymentManifest = {
  schemaVersion: number
  gharkVersion: string
  createdAt: string
  owner: Omit<UserContext, 'home'>
  images: {
    forgejo: string
    mirror: string
    restic: string
  }
  ports: {
    forgejoHttp: number
    forgejoSsh: number
    mirror: number
  }
  github: {
    username: string
    includePersonal: boolean
    organizations: string[]
  }
  backupTime: string
}

export type BackupState = {
  completedAt?: string
  durationSeconds?: number
  error?: string
  snapshotId?: string
  filesProcessed?: number
  bytesProcessed?: number
  verificationSubset?: number
  degraded?: boolean
  reconciliationError?: string
  success: boolean
}

export type ReconcileResult = {
  completedAt: string
  durationSeconds: number
  repositoriesScanned: number
  releaseUnitsEnabled: number
  repositoriesResynced: number
  releasesScanned: number
  assetsUploaded: number
  assetsReplaced: number
  assetsSkipped: number
  warnings: string[]
}

export type ReconcileState = ReconcileResult & {
  success: boolean
  error?: string
}
