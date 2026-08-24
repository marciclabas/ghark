import assert from 'node:assert/strict'
import test from 'node:test'
import { nextVersion } from '../scripts/release.js'

test('release version calculation supports stable increments and exact versions', () => {
  assert.equal(nextVersion('0.1.0', 'patch'), '0.1.1')
  assert.equal(nextVersion('0.1.0', 'minor'), '0.2.0')
  assert.equal(nextVersion('0.1.0', 'major'), '1.0.0')
  assert.equal(nextVersion('0.1.0', '0.1.5'), '0.1.5')
})

test('release version calculation rejects invalid or non-increasing versions', () => {
  assert.throws(() => nextVersion('0.1.0', '0.1.0'), /must be newer/)
  assert.throws(() => nextVersion('0.1.0', '0.0.9'), /must be newer/)
  assert.throws(() => nextVersion('0.1.0', 'next'), /stable semantic version/)
  assert.throws(() => nextVersion('0.1.0-beta.1', 'patch'), /stable semantic version/)
})
