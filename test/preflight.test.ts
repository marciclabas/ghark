import assert from 'node:assert/strict'
import test from 'node:test'
import { assertPrerequisites, findOtherGharkProject } from '../src/preflight.js'

test('Docker engine failures explain native and WSL recovery', () => {
  assert.throws(() => assertPrerequisites({
    commandExists: () => true,
    runCapture: (_command, args) => {
      if (args[0] === 'info') throw new Error('daemon unavailable')
      return ''
    }
  }), error => {
    assert.match(String(error), /Cannot connect to the Docker engine/)
    assert.match(String(error), /Docker Desktop/)
    assert.match(String(error), /WSL Integration/)
    assert.match(String(error), /docker info/)
    return true
  })
})

test('Docker Compose failures identify the missing plugin', () => {
  assert.throws(() => assertPrerequisites({
    commandExists: () => true,
    runCapture: () => { throw new Error('compose unavailable') }
  }), /Docker Compose is unavailable.*docker compose version/)
})

test('single-instance check accepts its own compose project', () => {
  const projects = JSON.stringify([{ Name: 'ghark', ConfigFiles: '/home/alice/ghark/compose.yaml' }])
  assert.equal(findOtherGharkProject(projects, '/home/alice/ghark'), undefined)
})

test('single-instance check identifies another deployment', () => {
  const projects = JSON.stringify([{ Name: 'ghark', ConfigFiles: '/home/bob/ghark/compose.yaml' }])
  assert.equal(findOtherGharkProject(projects, '/home/alice/ghark'), '/home/bob/ghark/compose.yaml')
})
