import { defaults, images, PACKAGE_NAME, PACKAGE_VERSION, SCHEMA_VERSION } from './constants.js'
import { serializeEnv } from './env.js'
import type { DeploymentManifest, InitAnswers, UserContext } from './types.js'

export function resticRepository(endpoint: string, bucket: string, prefix: string): string {
  const normalizedEndpoint = endpoint.replace(/\/$/, '')
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, '')
  return `s3:${normalizedEndpoint}/${bucket}${normalizedPrefix ? `/${normalizedPrefix}` : ''}`
}

export function createEnvironment(answers: InitAnswers, user: UserContext): Record<string, string> {
  return {
    PUID: String(user.uid),
    PGID: String(user.gid),
    FORGEJO_HTTP_PORT: String(answers.forgejoHttpPort),
    FORGEJO_SSH_PORT: String(answers.forgejoSshPort),
    MIRROR_PORT: String(answers.mirrorPort),
    ADMIN_USERNAME: answers.adminUsername,
    ADMIN_EMAIL: answers.adminEmail,
    ADMIN_PASSWORD: answers.adminPassword,
    FORGEJO_SECRET_KEY: crypto.randomUUID().replaceAll('-', ''),
    FORGEJO_INTERNAL_TOKEN: crypto.randomUUID().replaceAll('-', ''),
    FORGEJO_TOKEN: '',
    BETTER_AUTH_SECRET: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''),
    ENCRYPTION_SECRET: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''),
    GITHUB_USERNAME: answers.github.login,
    GITHUB_TOKEN: answers.github.token,
    INCLUDE_PERSONAL: String(answers.includePersonal),
    INCLUDE_ORGANIZATIONS: answers.organizations.join(','),
    MIRROR_ORGANIZATIONS: String(answers.organizations.length > 0),
    ONLY_MIRROR_ORGS: String(!answers.includePersonal),
    RESTIC_REPOSITORY: resticRepository(answers.s3.endpoint, answers.s3.bucket, answers.s3.prefix),
    RESTIC_PASSWORD: answers.s3.resticPassword,
    AWS_ACCESS_KEY_ID: answers.s3.accessKeyId,
    AWS_SECRET_ACCESS_KEY: answers.s3.secretAccessKey,
    AWS_DEFAULT_REGION: answers.s3.region,
    S3_ENDPOINT: answers.s3.endpoint.replace(/\/$/, ''),
    S3_BUCKET: answers.s3.bucket,
    S3_PREFIX: answers.s3.prefix.replace(/^\/+|\/+$/g, ''),
    S3_FORCE_PATH_STYLE: String(answers.s3.forcePathStyle),
    SCHEDULE_ENABLED: 'true',
    AUTO_IMPORT_REPOS: 'true',
    AUTO_MIRROR_REPOS: 'true',
    GITEA_MIRROR_INTERVAL: defaults.mirrorInterval,
    BACKUP_TIME: answers.backupTime,
    KEEP_DAILY: String(defaults.keepDaily),
    KEEP_WEEKLY: String(defaults.keepWeekly),
    KEEP_MONTHLY: String(defaults.keepMonthly)
  }
}

export function createManifest(answers: InitAnswers, user: UserContext): DeploymentManifest {
  return {
    schemaVersion: SCHEMA_VERSION,
    gharkVersion: PACKAGE_VERSION,
    createdAt: new Date().toISOString(),
    owner: { username: user.username, uid: user.uid, gid: user.gid },
    images: { ...images },
    ports: {
      forgejoHttp: answers.forgejoHttpPort,
      forgejoSsh: answers.forgejoSshPort,
      mirror: answers.mirrorPort
    },
    github: {
      username: answers.github.login,
      includePersonal: answers.includePersonal,
      organizations: answers.organizations
    },
    backupTime: answers.backupTime
  }
}

export function renderEnvironment(answers: InitAnswers, user: UserContext): string {
  return serializeEnv(createEnvironment(answers, user))
}

export function renderCompose(): string {
  return `name: ghark

services:
  forgejo:
    image: ${images.forgejo}
    restart: unless-stopped
    environment:
      USER_UID: \${PUID}
      USER_GID: \${PGID}
      ADMIN_USERNAME: \${ADMIN_USERNAME}
      ADMIN_EMAIL: \${ADMIN_EMAIL}
      ADMIN_PASSWORD: \${ADMIN_PASSWORD}
      FORGEJO__database__DB_TYPE: sqlite3
      FORGEJO__server__DOMAIN: localhost
      FORGEJO__server__ROOT_URL: http://localhost:\${FORGEJO_HTTP_PORT}/
      FORGEJO__server__SSH_DOMAIN: localhost
      FORGEJO__server__SSH_PORT: \${FORGEJO_SSH_PORT}
      FORGEJO__server__LFS_START_SERVER: "true"
      FORGEJO__service__DISABLE_REGISTRATION: "true"
      FORGEJO__service__REQUIRE_SIGNIN_VIEW: "true"
      FORGEJO__security__INSTALL_LOCK: "true"
      FORGEJO__security__SECRET_KEY: \${FORGEJO_SECRET_KEY}
      FORGEJO__security__INTERNAL_TOKEN: \${FORGEJO_INTERNAL_TOKEN}
      FORGEJO__actions__ENABLED: "false"
      FORGEJO__mirror__MIN_INTERVAL: 10m
      FORGEJO__repository__DEFAULT_MIRROR_REPO_UNITS: repo.code,repo.releases,repo.issues,repo.wiki,repo.projects,repo.packages
    ports:
      - "127.0.0.1:\${FORGEJO_HTTP_PORT}:3000"
      - "127.0.0.1:\${FORGEJO_SSH_PORT}:22"
    volumes:
      - ./data/forgejo:/data
    healthcheck:
      test: ["CMD", "wget", "--spider", "--quiet", "http://localhost:3000/api/healthz"]
      interval: 10s
      timeout: 5s
      retries: 30

  gitea-mirror:
    image: ${images.mirror}
    user: "\${PUID}:\${PGID}"
    restart: unless-stopped
    depends_on:
      forgejo:
        condition: service_healthy
    environment:
      NODE_ENV: production
      PUID: \${PUID}
      PGID: \${PGID}
      DATABASE_URL: file:data/gitea-mirror.db
      HOST: 0.0.0.0
      PORT: 4321
      BETTER_AUTH_URL: http://localhost:\${MIRROR_PORT}
      PUBLIC_BETTER_AUTH_URL: http://localhost:\${MIRROR_PORT}
      BETTER_AUTH_SECRET: \${BETTER_AUTH_SECRET}
      ENCRYPTION_SECRET: \${ENCRYPTION_SECRET}
      GITHUB_USERNAME: \${GITHUB_USERNAME}
      GITHUB_TOKEN: \${GITHUB_TOKEN}
      GITEA_URL: http://forgejo:3000
      GITEA_EXTERNAL_URL: http://localhost:\${FORGEJO_HTTP_PORT}
      GITEA_USERNAME: \${ADMIN_USERNAME}
      GITEA_TOKEN: \${FORGEJO_TOKEN}
      PRIVATE_REPOSITORIES: "true"
      PUBLIC_REPOSITORIES: "true"
      INCLUDE_ARCHIVED: "true"
      INCLUDE_COLLABORATOR_REPOS: "false"
      SKIP_FORKS: "false"
      MIRROR_ORGANIZATIONS: \${MIRROR_ORGANIZATIONS}
      INCLUDE_ORGANIZATIONS: \${INCLUDE_ORGANIZATIONS}
      ONLY_MIRROR_ORGS: \${ONLY_MIRROR_ORGS}
      PRESERVE_ORG_STRUCTURE: "true"
      MIRROR_STRATEGY: preserve
      GITEA_PRESERVE_VISIBILITY: "true"
      GITEA_ORG_VISIBILITY: private
      GITEA_LFS: "true"
      GITEA_FORK_STRATEGY: full-copy
      MIRROR_RELEASES: "true"
      RELEASE_LIMIT: "100"
      MIRROR_WIKI: "true"
      MIRROR_METADATA: "true"
      MIRROR_ISSUES: "true"
      MIRROR_PULL_REQUESTS: "true"
      MIRROR_LABELS: "true"
      MIRROR_MILESTONES: "true"
      MIRROR_ISSUE_CONCURRENCY: "1"
      MIRROR_PULL_REQUEST_CONCURRENCY: "1"
      SCHEDULE_ENABLED: \${SCHEDULE_ENABLED}
      GITEA_MIRROR_INTERVAL: \${GITEA_MIRROR_INTERVAL}
      SCHEDULE_CONCURRENT: "false"
      AUTO_IMPORT_REPOS: \${AUTO_IMPORT_REPOS}
      AUTO_MIRROR_REPOS: \${AUTO_MIRROR_REPOS}
      CLEANUP_DELETE_IF_NOT_IN_GITHUB: "false"
      CLEANUP_ORPHANED_REPO_ACTION: archive
    ports:
      - "127.0.0.1:\${MIRROR_PORT}:4321"
    volumes:
      - ./data/gitea-mirror:/app/data
    healthcheck:
      test: ["CMD-SHELL", "wget --quiet --spider http://localhost:4321/api/health"]
      interval: 10s
      timeout: 5s
      retries: 30

  restic:
    image: ${images.restic}
    profiles: ["tools"]
    environment:
      RESTIC_REPOSITORY: \${RESTIC_REPOSITORY}
      RESTIC_PASSWORD: \${RESTIC_PASSWORD}
      AWS_ACCESS_KEY_ID: \${AWS_ACCESS_KEY_ID}
      AWS_SECRET_ACCESS_KEY: \${AWS_SECRET_ACCESS_KEY}
      AWS_DEFAULT_REGION: \${AWS_DEFAULT_REGION}
    volumes:
      - ./:/source:ro
    working_dir: /source
`
}

export function renderSystemdService(root: string, user: UserContext): string {
  return `[Unit]
Description=Back up ghark to S3
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
User=${user.username}
Group=${user.gid}
Environment=HOME=${user.home}
ExecStart=${root}/.cli/node_modules/.bin/ghark backup start
`
}

export function renderSystemdTimer(backupTime: string): string {
  return `[Unit]
Description=Nightly ghark backup

[Timer]
OnCalendar=*-*-* ${backupTime}:00
Persistent=true
RandomizedDelaySec=10m
Unit=ghark-backup.service

[Install]
WantedBy=timers.target
`
}

export function renderPinnedPackage(): string {
  return `${JSON.stringify({
    name: 'ghark-deployment',
    private: true,
    dependencies: { [PACKAGE_NAME]: PACKAGE_VERSION }
  }, null, 2)}\n`
}
