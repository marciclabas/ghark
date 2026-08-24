import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { removePinnedCli } from '../src/install.js'
import type { UserContext } from '../src/types.js'

function fixture(): { parent: string, root: string, launcher: string, user: UserContext } {
  const parent = mkdtempSync(join(tmpdir(), 'ghark-install-test-'))
  const root = join(parent, 'ghark')
  const launcher = join(parent, '.local', 'bin', 'ghark')
  mkdirSync(join(parent, '.local', 'bin'), { recursive: true })
  return {
    parent,
    root,
    launcher,
    user: { username: 'tester', uid: 1000, gid: 1000, home: parent }
  }
}

test('removePinnedCli removes the launcher managed by this deployment', () => {
  const { parent, root, launcher, user } = fixture()
  try {
    symlinkSync(join(root, '.cli', 'node_modules', '.bin', 'ghark'), launcher)
    removePinnedCli(root, user)
    assert.equal(existsSync(launcher), false)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('removePinnedCli preserves a launcher pointing somewhere else', () => {
  const { parent, root, launcher, user } = fixture()
  try {
    const other = join(parent, 'another-ghark')
    writeFileSync(other, '')
    symlinkSync(other, launcher)
    removePinnedCli(root, user)
    assert.equal(readlinkSync(launcher), other)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
