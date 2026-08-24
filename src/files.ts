import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

export function writeAtomic(path: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, content, { encoding: 'utf8', mode })
  chmodSync(temporary, mode)
  renameSync(temporary, path)
}

export function writeJson(path: string, value: unknown, mode = 0o644): void {
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode)
}
