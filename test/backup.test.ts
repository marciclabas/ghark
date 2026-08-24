import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { backupUnlocked, BackupCancelledError } from '../src/backup.js'
import type { BackupDependencies } from '../src/backup.js'
import type { Service } from '../src/constants.js'
import { writeAtomic } from '../src/files.js'

function rootWithEnvironment(): string {
  const root = mkdtempSync(join(tmpdir(), 'ghark-backup-test-'))
  writeAtomic(join(root, '.env'), "KEEP_DAILY='7'\nKEEP_WEEKLY='4'\nKEEP_MONTHLY='12'\nGITHUB_TOKEN='secret-token'\n", 0o600)
  return root
}

function dependencies(running: Service[], reconcile: BackupDependencies['reconcile']): { dependencies: Partial<BackupDependencies>, resticCalls: string[][] } {
  const resticCalls: string[][] = []
  return {
    resticCalls,
    dependencies: {
      runningServices: () => running,
      compose: () => '',
      reconcile,
      now: () => 1_000,
      restic: (_root, _values, args) => {
        resticCalls.push(args)
        return args[0] === 'backup'
          ? JSON.stringify({ message_type: 'summary', snapshot_id: 'snapshot-1', total_files_processed: 3, total_bytes_processed: 42 })
          : ''
      }
    }
  }
}

test('continues snapshot retention and verification after reconciliation failure, then reports degradation', async () => {
  const root = rootWithEnvironment()
  try {
    const setup = dependencies(['forgejo', 'gitea-mirror'], async () => { throw new Error('GitHub failed with secret-token') })
    await assert.rejects(backupUnlocked(root, setup.dependencies), /\[REDACTED\]/)
    assert.deepEqual(setup.resticCalls.map(args => args[0]), ['backup', 'forget', 'check', 'check'])
    const state = JSON.parse(readFileSync(join(root, 'backup-state.json'), 'utf8')) as Record<string, unknown>
    assert.equal(state.degraded, true)
    assert.equal(state.success, true)
    assert.equal(state.snapshotId, 'snapshot-1')
    assert.equal(String(state.reconciliationError).includes('secret-token'), false)
    assert.equal(state.error, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skips reconciliation without degradation when Gitea Mirror was already stopped', async () => {
  const root = rootWithEnvironment()
  let reconciliations = 0
  try {
    const setup = dependencies(['forgejo'], async () => { reconciliations += 1; throw new Error('must not run') })
    await backupUnlocked(root, setup.dependencies)
    const state = JSON.parse(readFileSync(join(root, 'backup-state.json'), 'utf8')) as Record<string, unknown>
    assert.equal(reconciliations, 0)
    assert.equal(state.success, true)
    assert.equal(state.degraded, undefined)
    assert.equal(state.snapshotId, 'snapshot-1')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cancellation records failure and restores services stopped for the snapshot', async () => {
  const root = rootWithEnvironment()
  const controller = new AbortController()
  const composeCalls: string[][] = []
  try {
    await assert.rejects(backupUnlocked(root, {
      runningServices: () => ['forgejo', 'gitea-mirror'],
      compose: (_root, args) => { composeCalls.push(args); return '' },
      reconcile: async () => ({
        completedAt: '', durationSeconds: 0, repositoriesScanned: 0, releaseUnitsEnabled: 0,
        repositoriesResynced: 0, releasesScanned: 0, assetsUploaded: 0,
        assetsReplaced: 0, assetsSkipped: 0, warnings: []
      }),
      restic: async () => {
        controller.abort()
        throw new Error('command interrupted')
      },
      now: () => 1_000,
      progress: () => {},
      signal: controller.signal
    }), BackupCancelledError)
    assert.deepEqual(composeCalls, [
      ['stop', '--timeout', '60', 'gitea-mirror'],
      ['stop', '--timeout', '60', 'forgejo'],
      ['up', '--detach', 'forgejo'],
      ['up', '--detach', 'gitea-mirror']
    ])
    const state = JSON.parse(readFileSync(join(root, 'backup-state.json'), 'utf8')) as Record<string, unknown>
    assert.equal(state.success, false)
    assert.match(String(state.error), /cancelled by operator/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
