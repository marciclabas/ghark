import assert from 'node:assert/strict'
import test from 'node:test'
import { deploymentFiles, deploymentPath, resolveUserContext } from '../src/paths.js'

test('test home resolves to one fixed ghark directory', () => {
  const user = resolveUserContext({ ...process.env, SUDO_USER: undefined, GHARK_TEST_HOME: '/tmp/alice' })
  assert.equal(deploymentPath(user), '/tmp/alice/ghark')
  assert.equal(deploymentFiles(deploymentPath(user)).lock, '/tmp/alice/.ghark-operation.lock')
})
