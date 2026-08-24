import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseEnv } from '../src/env.js'

const values = parseEnv(readFileSync('.env.test', 'utf8'))
const token = values.GHARK_TEST_GITHUB_TOKEN
const repository = values.GHARK_TEST_GITHUB_REPOSITORY
if (!token || !repository) throw new Error('.env.test requires GHARK_TEST_GITHUB_TOKEN and GHARK_TEST_GITHUB_REPOSITORY')

const authenticatedEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  GH_TOKEN: token,
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
  GIT_CONFIG_VALUE_0: '!gh auth git-credential'
}

function run(command: string, args: string[], cwd?: string, capture = false): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: authenticatedEnvironment,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed${capture && result.stderr ? `: ${result.stderr.trim()}` : ''}`)
  return result.stdout?.trim() ?? ''
}

const root = mkdtempSync(join(tmpdir(), 'ghark-github-fixture-'))
const checkout = join(root, basename(repository))

try {
  run('gh', ['repo', 'clone', repository, checkout])
  run('git', ['config', 'user.name', 'ghark fixture'], checkout)
  run('git', ['config', 'user.email', 'ghark-fixture@users.noreply.github.com'], checkout)
  run('git', ['lfs', 'install', '--local'], checkout)
  run('git', ['lfs', 'track', 'fixtures/*.bin'], checkout)

  mkdirSync(join(checkout, 'docs'), { recursive: true })
  mkdirSync(join(checkout, 'fixtures'), { recursive: true })
  writeFileSync(join(checkout, 'docs', 'mirror-source.md'), '# Mirror fixture\n\nThis content must survive GitHub mirroring and S3 recovery.\n')
  const lfsPayload = Buffer.alloc(1024 * 1024)
  for (let index = 0; index < lfsPayload.length; index += 1) lfsPayload[index] = index % 251
  writeFileSync(join(checkout, 'fixtures', 'large.bin'), lfsPayload)
  run('git', ['add', '.gitattributes', 'docs/mirror-source.md', 'fixtures/large.bin'], checkout)
  run('git', ['commit', '-m', 'Add mirror and LFS fixtures'], checkout)
  run('git', ['push', 'origin', 'main'], checkout)
  run('git', ['lfs', 'push', 'origin', '--all'], checkout)

  run('git', ['switch', '-c', 'fixture-change'], checkout)
  writeFileSync(join(checkout, 'docs', 'pull-request.md'), '# Pull request fixture\n\nThis branch exercises PR metadata and comments.\n')
  run('git', ['add', 'docs/pull-request.md'], checkout)
  run('git', ['commit', '-m', 'Add pull request fixture'], checkout)
  run('git', ['push', '--set-upstream', 'origin', 'fixture-change'], checkout)

  run('gh', ['label', 'create', 'mirror-fixture', '--repo', repository, '--color', '1D76DB', '--description', 'Data used by ghark integration tests', '--force'])
  run('gh', ['api', `repos/${repository}/milestones`, '--method', 'POST', '-f', 'title=Mirror test v1', '-f', 'description=Milestone used to validate metadata mirroring'])
  const issue = run('gh', [
    'issue', 'create', '--repo', repository,
    '--title', 'Mirror issue fixture',
    '--body', 'This issue, its label, milestone, and comments must appear in Forgejo.',
    '--label', 'mirror-fixture', '--milestone', 'Mirror test v1'
  ], undefined, true)
  run('gh', ['issue', 'comment', issue, '--body', 'Issue comment fixture for ghark.'])

  const pullRequest = run('gh', [
    'pr', 'create', '--repo', repository,
    '--base', 'main', '--head', 'fixture-change',
    '--title', 'Mirror pull request fixture',
    '--body', 'This pull request and its comment must be represented by the standby.'
  ], undefined, true)
  run('gh', ['pr', 'comment', pullRequest, '--body', 'Pull request comment fixture for ghark.'])

  const asset = join(root, 'release-asset.txt')
  writeFileSync(asset, 'ghark release asset fixture\n')
  run('gh', [
    'release', 'create', 'v0.1.0', `${asset}#release-asset.txt`,
    '--repo', repository, '--target', 'main',
    '--title', 'Fixture release v0.1.0', '--notes', 'Release metadata and asset used by ghark tests.'
  ])

  const wiki = join(root, 'wiki')
  mkdirSync(wiki)
  run('git', ['init', '--initial-branch', 'master'], wiki)
  run('git', ['config', 'user.name', 'ghark fixture'], wiki)
  run('git', ['config', 'user.email', 'ghark-fixture@users.noreply.github.com'], wiki)
  writeFileSync(join(wiki, 'Home.md'), '# Ghark fixture wiki\n\nThis page must survive mirroring and recovery.\n')
  run('git', ['add', 'Home.md'], wiki)
  run('git', ['commit', '-m', 'Add fixture wiki'], wiki)
  run('git', ['remote', 'add', 'origin', `https://github.com/${repository}.wiki.git`], wiki)
  try {
    run('git', ['push', '--set-upstream', 'origin', 'master'], wiki)
  } catch {
    console.warn('GitHub did not expose the private wiki Git repository. Initialize its first page in the web UI to enable the wiki fixture.')
  }

  console.log(`GitHub fixture populated: https://github.com/${repository}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
