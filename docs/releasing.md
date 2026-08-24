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

1. Update `version` in `package.json` and `package-lock.json` on `main`.
2. Let CI pass.
3. Publish a GitHub Release whose tag is exactly `v` followed by that version,
   for example `v0.2.0`.
4. The `publish.yml` workflow verifies the tag, runs the test suite, builds the
   package, and publishes it with npm provenance.

Never reuse an npm version. If the workflow fails after npm accepts a version,
bump the version before trying again.
