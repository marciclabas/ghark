import assert from 'node:assert/strict'
import test from 'node:test'
import { parseEnv, redact, serializeEnv } from '../src/env.js'

test('environment serialization round-trips protected values', () => {
  const values = {
    SIMPLE: 'value',
    QUOTED: "o'clock",
    SPACE: 'two words',
    EMPTY: ''
  }
  assert.deepEqual(parseEnv(serializeEnv(values)), values)
})

test('redaction replaces every known secret', () => {
  assert.equal(redact('token=secret-value password=hunter22', ['secret-value', 'hunter22']), 'token=[REDACTED] password=[REDACTED]')
})
