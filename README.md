# ghark

Your GitHub repositories, safely aboard.

`ghark` is a small, self-hosted GitHub mirror and warm standby. It runs
[Forgejo](https://forgejo.org/) and
[Gitea Mirror](https://github.com/RayLabsHQ/gitea-mirror) with safe defaults,
then backs up the complete deployment to S3-compatible storage with
[restic](https://restic.net/).

GitHub remains authoritative during normal operation. If GitHub becomes
unavailable, the mirrored repositories and their principal collaboration
metadata remain accessible in Forgejo.

## Quick start

You need a Linux VM with Node.js, npm, Docker, and Docker Compose.

```sh
npx @marciclabas/ghark init
```

The deployment always lives at `~/ghark`. ghark supports one deployment per
host; its ports remain configurable only to avoid conflicts with unrelated
services.

The wizard:

1. Checks the host and creates the deployment.
2. Offers the active GitHub CLI login, with a masked classic-token fallback.
3. Lists every visible GitHub organization and asks which ones to mirror.
4. Separately asks whether to include repositories owned by your personal account.
5. Configures one shared administrator login for Forgejo and Gitea Mirror.
6. Initializes an encrypted restic repository in S3-compatible storage.
7. Starts the services and installs the nightly backup timer.

The GitHub credential needs `repo` and `read:org` access. Organization selection
is an explicit allowlist: selecting no organizations never means “all.” Public,
private, archived, and forked repositories owned by the selected accounts are
included; repositories where you are only a collaborator are not.

Keep the generated restic recovery password outside the VM, preferably in a
password manager. It is required to recover the deployment if the VM is lost.
When connecting initialization to an existing restic repository, the wizard
asks for that repository's password instead of creating a new one.

## Operations

Run commands from anywhere:

```sh
ghark status
ghark logs
ghark verify
ghark reconcile
ghark backup
ghark update
```

Other recovery and configuration commands are discoverable through `ghark help`.

Forgejo and Gitea Mirror listen only on loopback by default. `ghark status`
prints their URLs and an SSH tunnel command for remote access.

## First-release preservation target

1. Git repositories and refs.
2. Git LFS objects and wikis.
3. Issues, pull-request records and comments.
4. Labels and milestones.
5. Releases and release assets.
6. The configuration and state required to restore the standby.

GitHub Discussions, Projects, Actions history and artifacts, packages, secrets,
and every repository setting are outside the initial scope.

Gitea Mirror remains responsible for discovering and creating release metadata.
Before an online backup, ghark reconciles Forgejo mirrors whose Releases unit
was not enabled during migration, asks Gitea Mirror to sync those repositories,
and repairs missing private release assets with authenticated streaming
downloads. `ghark reconcile` runs the same operation manually for diagnosis.

If online reconciliation fails, `ghark backup` still captures, retains, and
verifies the last known good local state, then exits non-zero and records the
snapshot as degraded. `ghark status` distinguishes that outcome from a failed
snapshot lifecycle. If synchronization was deliberately stopped with
`ghark stop-sync`, backup takes an offline snapshot without reconciliation or a
degradation warning.

## Recovery

`ghark restore` restores an encrypted restic snapshot into an empty deployment.
It never overwrites a running installation without explicit confirmation.

Failover is deliberately guided rather than automatic. Promoting Forgejo makes
it authoritative and must be an operator decision:

```sh
ghark stop-sync
ghark backup
ghark failover-guide
```

See [the specification](docs/spec.md) for the complete behavior, security model,
backup lifecycle, and recovery procedure.

## Development

```sh
npm install
npm run check
npm pack
```

Test the S3 path locally with Docker and MinIO:

```sh
npm run test:minio
```

Exercise the pinned Forgejo and Gitea Mirror bootstrap contract in an isolated
Compose project:

```sh
npm run test:upstream
```

That smoke test creates the shared administrator, signs in, and verifies that an
explicit organization allowlist reaches Gitea Mirror's persisted configuration.
It uses a deliberately invalid GitHub token, so it never accesses a real account.

The authenticated mirror test reads a gitignored, mode-`0600` `.env.test`:

```dotenv
GHARK_TEST_GITHUB_TOKEN=...
GHARK_TEST_GITHUB_REPOSITORY=marciclabas/ghark-test-fixture
```

Run it with Git LFS installed:

```sh
npm run test:github
```

It imports visible repository metadata into an isolated database but starts a
mirror job only for the configured fixture. The test verifies release-unit and
private-asset reconciliation twice to prove idempotence. The stack and its
volumes are removed afterward, including on failure.

To test the packaged executable without publishing it, install the tarball into
an empty directory and run `npx --no-install ghark --version`. A local npm
registry such as Verdaccio can additionally exercise the exact scoped
`npx @marciclabas/ghark` resolution path.

Maintainers publish through npm Trusted Publishing and GitHub Actions. See
[the release guide](docs/releasing.md) for the one-time npm bootstrap and the
guarded `npm run release -- patch` workflow.
