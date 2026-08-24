import assert from 'node:assert/strict'
import test from 'node:test'
import { findOtherGharkProject } from '../src/preflight.js'

test('single-instance check accepts its own compose project', () => {
  const projects = JSON.stringify([{ Name: 'ghark', ConfigFiles: '/home/alice/ghark/compose.yaml' }])
  assert.equal(findOtherGharkProject(projects, '/home/alice/ghark'), undefined)
})

test('single-instance check identifies another deployment', () => {
  const projects = JSON.stringify([{ Name: 'ghark', ConfigFiles: '/home/bob/ghark/compose.yaml' }])
  assert.equal(findOtherGharkProject(projects, '/home/alice/ghark'), '/home/bob/ghark/compose.yaml')
})
