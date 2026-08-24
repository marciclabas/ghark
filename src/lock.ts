import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

export async function withOperationLock<T>(path: string, operation: string, callback: () => Promise<T>): Promise<T> {
  try {
    mkdirSync(path)
  } catch {
    let detail = ''
    try {
      detail = readFileSync(`${path}/owner`, 'utf8').trim()
    } catch {
      // The owner marker is diagnostic only.
    }
    throw new Error(`Another ghark operation is active${detail ? ` (${detail})` : ''}`)
  }

  writeFileSync(`${path}/owner`, `${operation} pid=${process.pid} started=${new Date().toISOString()}\n`)
  try {
    return await callback()
  } finally {
    rmSync(path, { recursive: true, force: true })
  }
}
