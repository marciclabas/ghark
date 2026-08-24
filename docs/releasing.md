# Releasing ghark

Releases are published to the public npm registry as `ghark`.
GitHub Actions uses npm Trusted Publishing (OIDC), so the repository does not
store a long-lived npm write token.

## One-time bootstrap

Npm requires a package to exist before a trusted publisher can be attached.
For version `0.1.0`, publish once from a clean checkout using the npm account
that will own the package:

```sh
npm login
npm ci
npm run check
npm publish
```

Then open the package settings on npmjs.com and add this trusted publisher:

- Provider: GitHub Actions
- Organization or user: `marciclabas`
- Repository: `ghark`
- Workflow filename: `publish.yml`
- Environment: leave empty
- Allowed action: `npm publish`

After a successful OIDC publication, set the package's publishing access to
require two-factor authentication and disallow tokens.

## Subsequent releases

Use the guarded release command from a clean, up-to-date `main` branch:

```sh
npm run release -- patch
# or: yarn release patch
```

`minor`, `major`, and an exact newer stable version such as `0.2.3` are also
accepted. Add `--dry-run` to perform all read-only validation and tests without
changing Git or creating a release. Add `--yes` only for intentional
non-interactive execution.

The command checks the branch, remote, clean worktree, remote synchronization,
tag availability, npm version availability, GitHub authentication, and test
suite. After confirmation it updates both package manifests, commits and tags
the version, atomically pushes `main` and the tag, and creates the GitHub
Release. The `publish.yml` workflow then verifies the tag, tests, builds, and
publishes with npm provenance.

Never reuse an npm version. If the workflow fails after npm accepts a version,
bump the version before trying again.
