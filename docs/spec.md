# ghark specification

## 1. Purpose

`ghark` packages Forgejo and Gitea Mirror as a self-hosted GitHub mirror, warm
standby, and encrypted off-site backup. Its value is installation and operations:
it does not reimplement either upstream application.

The primary audience is an individual developer or small organization running a
persistent Linux VM. The deployment must be understandable without knowledge of
its implementation and recoverable without access to its original host.

The initial release has four goals:

1. Install and configure the complete stack through one interactive command.
2. Continuously mirror personal and organization repositories from GitHub.
3. Create encrypted, versioned, verified backups in required S3-compatible
   storage.
4. Provide clear health, recovery, and manual failover workflows.

## 2. System model

### 2.1 Components

The runtime consists of pinned container images:

1. **Forgejo** stores and serves the standby repositories and metadata.
2. **Gitea Mirror** discovers GitHub repositories and synchronizes them into
   Forgejo.
3. **restic** runs as a one-shot Compose service for backup, verification,
   retention, and restore operations.

The `ghark` npm package is the operator interface. It generates configuration,
invokes Docker Compose, installs the backup timer, coordinates consistent
backups, and explains recovery. It is not a long-running service.

### 2.2 Authority

GitHub is the only writable source during normal operation. Forgejo is a
read-only operational standby. Gitea Mirror performs one-way synchronization
from GitHub to Forgejo.

Once an operator promotes Forgejo and performs the first write there, Gitea
Mirror must remain stopped until the two systems are deliberately reconciled.

### 2.3 Network exposure

Forgejo HTTP, Forgejo SSH, and the Gitea Mirror UI bind to `127.0.0.1` by
default. Remote operators connect through an SSH tunnel. Public binding and
reverse-proxy deployment are explicit advanced configuration.

Actions are disabled in Forgejo. Public registration is disabled after the
administrative accounts have been provisioned.

## 3. Installation and configuration

### 3.1 Entry point

The public initializer is:

```sh
npx @marciclabas/ghark init
```

The deployment always lives at `~/ghark`, resolved from the home directory of
the user who invoked ghark. When a narrow privileged operation runs through
`sudo`, ghark uses `SUDO_USER` rather than treating `/root` as the deployment
owner. A direct root login uses `/root/ghark`.

ghark supports one deployment per host. Initialization checks for the fixed
Compose project and systemd units and refuses to create a second deployment.
Re-running initialization against the existing `~/ghark` is idempotent: it
preserves data and secrets and only asks about missing or explicitly changed
settings. Moving a deployment is not a supported operation; recovery uses the
documented restore workflow.

### 3.2 Deployment contents

The deployment is self-contained and operator-visible:

```text
~/ghark/
  compose.yaml
  .env
  deployment.json
  backup-state.json
  reconcile-state.json
  .cli/
    package.json
    package-lock.json
  data/
    forgejo/
    gitea-mirror/
  systemd/
```

The npm dependency is pinned in `package-lock.json`; scheduled jobs never fetch
the latest package through `npx`. Initialization installs a `ghark` launcher in
the user's executable path, while systemd invokes the pinned package beneath
`~/ghark` by absolute path. `.env` is created with mode `0600`.
`deployment.json` contains no secrets and records the ghark version, pinned image
versions, schema version, creation time, and deployment owner.

Live application data uses bind mounts beneath `data/` so it is visible and
portable. Updates never remove or recreate that directory.

### 3.3 Prerequisites

The supported host is a systemd-based Linux VM with:

1. A currently supported Node.js LTS release and npm.
2. Docker Engine.
3. The Docker Compose plugin exposed as `docker compose`.
4. Enough local space for the complete mirror and Docker working data.
5. Outbound HTTPS access to GitHub, the container registries, and the configured
   S3 endpoint.

The initializer diagnoses missing prerequisites and prints exact remediation. It
does not silently replace an existing Docker installation.

### 3.4 Wizard inputs

The wizard collects and validates:

1. Local HTTP/SSH ports.
2. One shared Forgejo and Gitea Mirror administrator identity.
3. The active GitHub CLI credential, when present, or a masked classic token.
4. An explicit allowlist selected from the authenticated user's visible GitHub
   organizations.
5. A separate choice to include repositories owned by the personal account.
6. S3 endpoint, region, bucket, prefix, access key, secret key, and addressing
   style.

At least the personal account or one organization must be selected. An empty
organization selection means no organizations, never every organization. The
initial policy includes owned public, private, archived, and forked repositories
and excludes collaborator-only and starred repositories. The mirror interval is
one hour, backups run at `03:17` in the host timezone, and retention defaults to
7 daily, 4 weekly, and 12 monthly snapshots.

S3 configuration is mandatory. Initialization verifies bucket access before
starting the deployment and fails without changing existing state if access is
invalid.

The initializer generates independent cryptographic secrets for Forgejo, Gitea
Mirror, and restic. It displays the restic recovery password once and requires
the operator to confirm that it has been stored outside the VM.

### 3.5 Upstream provisioning

Initialization fully provisions the upstream services. It uses supported
environment variables, command-line interfaces, and HTTP APIs in preference to
internal database writes.

The workflow is:

1. Generate Compose and protected configuration.
2. Start Forgejo and wait for its health endpoint.
3. Create the Forgejo administrator and a least-privilege service token.
4. Start Gitea Mirror and wait for its health endpoint.
5. Create its administrator, configure the Forgejo connection, and configure
   GitHub authorization and mirror policy.
6. Trigger initial discovery and report progress.

Any compatibility adapter that relies on an upstream implementation detail must
be isolated by upstream version and covered by an integration test. ghark never
attempts an unknown adapter against an unrecognized version.

Secrets are never accepted as command-line arguments, written to logs, or stored
in `deployment.json`.

## 4. Synchronization policy

The defaults favor preservation over cleanup:

1. Synchronization runs hourly and does not overlap.
2. Git refs, LFS, issues, pull requests, comments, labels, milestones, releases,
   release assets, and wikis are enabled.
3. Repository visibility and owner/organization structure are preserved.
4. New accessible repositories are discovered automatically.
5. Repositories missing from GitHub are retained in Forgejo.
6. Existing non-mirror destination repositories are never replaced.
7. Metadata concurrency is one by default to avoid GitHub rate-limit pressure.
8. Pull requests are represented as enriched Forgejo issues because the
   destination API cannot reconstruct native pull requests faithfully.

### 4.1 Release reconciliation

Gitea Mirror owns release discovery and release metadata. Ghark supplies a
focused compatibility operation for the authenticated GitHub-to-Forgejo path:

1. It obtains live source/destination mappings from Gitea Mirror's authenticated
   repository API rather than inferring organization layout.
2. It enables a missing Forgejo Releases unit and asks Gitea Mirror to resync
   only the affected existing repositories.
3. It waits a bounded five minutes for expected release metadata whose Git tags
   already exist in Forgejo.
4. For the newest 100 releases, it streams missing private assets from GitHub's
   authenticated asset API, validates size and available SHA-256 digests, and
   uploads them to the matching Forgejo release.

Exact name-and-size matches are idempotently skipped. A same-name replacement is
fully downloaded and validated before the stale Forgejo attachment is removed.
Releases and assets absent from GitHub are retained because Forgejo is a backup.
The latest counters, warnings, and sanitized failure are recorded in
`reconcile-state.json`. Tokens, cookies, authenticated bodies, and temporary
asset content are never persisted there.

GitHub Discussions, Projects, Actions history and artifacts, packages, secrets,
and complete repository settings are not separately archived.

## 5. Backup design

### 5.1 Repository

Backups use restic's native S3 backend. Amazon S3, Cloudflare R2, MinIO, and
other compatible providers are supported through endpoint, region, bucket, and
path-style configuration.

The repository URL is conceptually:

```text
s3:https://ENDPOINT/BUCKET/PREFIX
```

Restic encrypts content and metadata before upload. The S3 provider never
receives the restic repository password.

### 5.2 Consistent snapshot sequence

Only one backup may run at a time. A non-blocking lock rejects overlap between a
scheduled and manual run.

Each backup:

1. Validates configuration and S3 access.
2. Records exactly which application services are running.
3. If Forgejo and Gitea Mirror are running, reconciles release units, release
   metadata, and private release assets before freezing either service.
4. Stops Gitea Mirror to prevent new synchronization work.
5. Stops Forgejo after current work terminates cleanly.
6. Runs the one-shot restic service against `.env`, `deployment.json`,
   `compose.yaml`, the pinned `.cli` package manifests, and `data/`.
7. Restarts exactly the services that were running, even if restic fails.
8. Runs restic retention and repository checks with the services online.
9. Records the snapshot ID, sizes, duration, and verification result without
   logging secrets.

When Gitea Mirror was already stopped, step 3 is intentionally skipped. This
preserves the failover contract and produces an offline snapshot without making
GitHub requests.

The initial snapshot uploads all selected data. Later snapshots use restic's
content-defined deduplication and upload only content absent from the repository.
Because backup goes directly to S3, service downtime includes scanning and
network transfer. `ghark status` reports recent backup duration so operators can
decide whether a future local-staging mode is warranted.

### 5.3 Retention and verification

The default policy retains 7 daily, 4 weekly, and 12 monthly snapshots. Pruning
uses `restic forget --prune` and requires S3 credentials with deletion access.

Every successful backup runs `restic check`. Data verification rotates through
seven deterministic subsets using `--read-data-subset=N/7`, so all stored pack
files are read over seven successful scheduled runs. A manual full verification
is available through:

```sh
ghark verify --full
```

which uses `restic check --read-data` and may incur substantial S3 download and
request costs.

### 5.4 Failure behavior

Failure to stop a service aborts the snapshot. A failed restic operation does
not run retention. Service restart is attempted in a finalizer and is reported
independently from the backup result.

A backup is successful only when snapshot creation and the structural repository
check both succeed. Subset data-check failure marks the run failed and preserves
all snapshots for investigation.

Manual backups run in the foreground and report each lifecycle stage. Ctrl+C
aborts active reconciliation or restic work, records a cancelled failure, and
still runs the service-restart finalizer before exiting with status 130.

An online reconciliation failure does not prevent a valid snapshot of the last
known good local state. Ghark continues through freeze, snapshot, restart,
retention, and both verification checks, records the valid snapshot as
`degraded`, and returns non-zero afterward. A freeze, restic, restart, retention,
or verification error remains a failed snapshot lifecycle rather than a
degraded one.

The systemd timer is persistent, so a missed scheduled run starts after the next
boot. The backup lock prevents that run from overlapping a manual invocation.

## 6. Operator interface

The stable commands are:

```text
ghark init                   create or reconcile the deployment
ghark up                     pull pinned images and start services
ghark down                   stop services without deleting data
ghark status                 summarize health, sync, backup, storage, and timer
ghark logs [SERVICE]         show the latest redacted service logs
ghark configure github       change GitHub identity and organization selection
ghark configure backup       change S3 and restic credentials
ghark verify [--full]        check services and the S3 restic repository
ghark backup                 show backup command help without starting work
ghark backup start           create and verify a foreground backup immediately
ghark backup install         install or repair automatic backup scheduling
ghark backup uninstall       remove automatic scheduling only
ghark backup status          show timer state and latest backup result
ghark reconcile              reconcile releases and private release assets
ghark snapshots              list available recovery points
ghark restore [SNAPSHOT]     restore into an empty or confirmed target
ghark update                 apply a compatible ghark/upstream update
ghark stop-sync              stop Gitea Mirror for failover
ghark failover-guide         inspect readiness and print promotion steps
ghark install-timer          compatibility alias for backup install
```

Commands always operate on `~/ghark`; there is no directory option or
multi-instance mode. Configurable ports exist only to avoid collisions with
unrelated host services. Commands that require Docker or systemd privileges
request `sudo` for the narrow operation rather than requiring the entire CLI to
run as root.

`status` reports Compose service health, local endpoints, the SSH tunnel command,
deployment disk usage, the systemd timer, the last backup health (healthy,
degraded, or failed), and the latest reconciliation counters and time. Detailed
mirror-job history remains available in the Gitea Mirror UI. Status never prints
tokens, passwords, or secret environment values.

## 7. Restore and failover

### 7.1 Disaster restore

On a new Linux VM, the operator installs Node.js and Docker, obtains the S3
credentials and restic password, and runs:

```sh
npx @marciclabas/ghark restore
```

The command lists snapshots, restores the selected snapshot into a temporary
staging directory beside `~/ghark`, validates its manifest and expected paths,
and only then installs it at `~/ghark`. An existing deployment requires explicit
confirmation before replacement. After restoration, ghark validates Compose,
starts the services, verifies health, and reinstalls the timer.

Restore never initializes a new empty restic repository when the configured
repository cannot be opened; this protects against an incorrect endpoint or
password masquerading as an empty backup.

### 7.2 GitHub outage

Failover remains guided and manual:

1. Run `ghark stop-sync`.
2. Capture a final S3 snapshot if the storage provider is reachable.
3. Review the last successful synchronization and all incomplete jobs.
4. Convert one low-risk Forgejo pull mirror into a regular repository and verify
   a test push.
5. Promote the remaining selected repositories deliberately.
6. Change developer remotes to Forgejo.
7. Keep Gitea Mirror stopped after the first Forgejo write.

Returning authority to GitHub is a reconciliation exercise and is never
automatic.

## 8. Updates and compatibility

All container images and the ghark npm dependency are pinned to exact versions.
`ghark update` creates a verified pre-update backup, checks npm for a newer
release, installs it into the deployment's pinned `.cli`, migrates generated
deployment files, and reconciles the Compose application. When no newer ghark
release exists, it pulls and reconciles the already-pinned image versions.

If the pre-update backup fails, the update aborts. Data migrations are never
rolled back by replacing application files alone; recovery uses the captured
snapshot.

The generated configuration includes a schema version. Older compatible schemas
are migrated idempotently, while newer unknown schemas are rejected.

## 9. Security and safety

1. UIs bind to loopback unless the operator explicitly changes exposure.
2. Secrets are stored only in the mode-`0600` environment file and upstream
   encrypted stores.
3. Restic encrypts all S3 backup content and metadata.
4. The restic password must be stored outside the VM; ghark warns until the
   operator confirms this during initialization.
5. S3 credentials should be scoped to one bucket and prefix with only the
   list/read/write/delete permissions required by restic.
6. No command deletes live data, snapshots, or a deployment without explicit
   confirmation.
7. Missing GitHub repositories do not cause destination deletion.
8. Logs and diagnostics redact known secret values.
9. The backup container does not receive the Docker socket; the host CLI
   coordinates service state.

## 10. Acceptance criteria

The first release is complete when automated tests demonstrate that:

1. A clean supported VM can initialize exactly one stack at `~/ghark` and reject
   a second deployment.
2. Initialization is safe to repeat and preserves data and credentials.
3. Personal, private, organization, archived, forked, and LFS repositories are
   mirrored according to policy.
4. The documented metadata classes appear in Forgejo.
5. A scheduled backup creates an encrypted S3 snapshot, applies retention, and
   passes structural and rotating data checks.
6. Services restart after successful and failed backup attempts.
7. Concurrent backups are rejected without disturbing the active run.
8. A fresh VM can restore a selected snapshot and pass health checks without
   GitHub access.
9. Status and logs never reveal seeded test credentials.
10. Guided failover prevents synchronization from restarting after the operator
    declares Forgejo authoritative.

Integration tests pin the supported Forgejo, Gitea Mirror, restic, Node.js, and
Docker Compose version matrix. A release is blocked when an upstream bootstrap
adapter or restore drill fails.

### 10.1 Authenticated-test coverage

As of 2026-08-24, the private fixture test covers Git refs, Git LFS, issues,
pull-request records, labels, milestones, a release, and its private asset
against Gitea Mirror v3.28.0 with Forgejo 16.0.3. It demonstrates that ghark
enables the Releases unit, lets Gitea Mirror create release metadata, streams
the authenticated asset into Forgejo, and makes no changes on a second
reconciliation. Other repositories visible to the test token are never sent to
Forgejo.
