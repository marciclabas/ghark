import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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

test('operation lock automatically recovers ownership from a dead process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ghark-lock-'))
  const lock = join(root, 'lock')
  mkdirSync(lock)
  writeFileSync(join(lock, 'owner'), 'backup pid=2147483647 started=2026-01-01T00:00:00.000Z\n')

  let ran = false
  await withOperationLock(lock, 'backup', async () => { ran = true })
  assert.equal(ran, true)
  assert.equal(existsSync(lock), false)
})

test('operation lock does not reclaim ownership from a live process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ghark-lock-'))
  const lock = join(root, 'lock')
  mkdirSync(lock)
  writeFileSync(join(lock, 'owner'), `backup pid=${process.pid} started=2026-01-01T00:00:00.000Z\n`)

  await assert.rejects(withOperationLock(lock, 'backup', async () => undefined), /Another ghark operation is active/)
  assert.equal(existsSync(lock), true)
})
