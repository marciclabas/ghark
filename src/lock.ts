import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

function owner(path: string): { detail: string, pid?: number } {
  try {
    const detail = readFileSync(`${path}/owner`, 'utf8').trim()
    const rawPid = detail.match(/(?:^|\s)pid=(\d+)(?:\s|$)/)?.[1]
    const pid = rawPid ? Number(rawPid) : undefined
    return { detail, ...(pid && Number.isSafeInteger(pid) ? { pid } : {}) }
  } catch {
    return { detail: '' }
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export async function withOperationLock<T>(path: string, operation: string, callback: () => Promise<T>): Promise<T> {
  let acquired = false
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      mkdirSync(path)
      acquired = true
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const current = owner(path)
      if (!existsSync(path)) continue
      if (!current.pid || processIsRunning(current.pid)) {
        throw new Error(`Another ghark operation is active${current.detail ? ` (${current.detail})` : ''}`)
      }

      const stalePath = `${path}.stale-${current.pid}-${process.pid}`
      try {
        renameSync(path, stalePath)
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw renameError
      }
      rmSync(stalePath, { recursive: true, force: true })
      console.warn(`Recovered stale ghark operation lock (${current.detail}).`)
    }
  }
  if (!acquired) throw new Error('Could not acquire the ghark operation lock after recovering stale ownership')

  writeFileSync(`${path}/owner`, `${operation} pid=${process.pid} started=${new Date().toISOString()}\n`)
  try {
    return await callback()
  } finally {
    rmSync(path, { recursive: true, force: true })
  }
}
