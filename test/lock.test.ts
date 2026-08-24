import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { withOperationLock } from '../src/lock.js'

test('operation lock rejects overlap and is removed by the finalizer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ghark-lock-'))
  const lock = join(root, 'lock')
  await withOperationLock(lock, 'outer', async () => {
    await assert.rejects(withOperationLock(lock, 'inner', async () => undefined), /Another ghark operation/)
    assert.equal(existsSync(lock), true)
  })
  assert.equal(existsSync(lock), false)
})

test('operation lock is removed after failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ghark-lock-'))
  const lock = join(root, 'lock')
  await assert.rejects(withOperationLock(lock, 'failure', async () => {
    throw new Error('boom')
  }), /boom/)
  assert.equal(existsSync(lock), false)
})
