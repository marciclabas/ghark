import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

async function line(question: string): Promise<string> {
  const reader = createInterface({ input: stdin, output: stdout })
  try {
    return (await reader.question(question)).trim()
  } finally {
    reader.close()
  }
}

export async function promptText(label: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : ''
  const value = await line(`${label}${suffix}: `)
  return value || defaultValue || ''
}

export async function promptRequired(label: string, defaultValue?: string): Promise<string> {
  while (true) {
    const value = await promptText(label, defaultValue)
    if (value) return value
    console.error('A value is required.')
  }
}

export async function promptConfirm(label: string, defaultValue = true): Promise<boolean> {
  const hint = defaultValue ? 'Y/n' : 'y/N'
  while (true) {
    const value = (await line(`${label} [${hint}]: `)).toLowerCase()
    if (!value) return defaultValue
    if (value === 'y' || value === 'yes') return true
    if (value === 'n' || value === 'no') return false
    console.error('Enter yes or no.')
  }
}

export async function promptNumber(label: string, defaultValue: number, validate?: (value: number) => boolean): Promise<number> {
  while (true) {
    const raw = await promptText(label, String(defaultValue))
    const value = Number(raw)
    if (Number.isInteger(value) && (!validate || validate(value))) return value
    console.error('Enter a valid number.')
  }
}

export async function promptSecret(label: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode) return await promptRequired(label)

  stdout.write(`${label}: `)
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')

  return await new Promise((resolve, reject) => {
    let value = ''
    const finish = () => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      stdout.write('\n')
    }
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          finish()
          reject(new Error('Cancelled'))
          return
        }
        if (character === '\r' || character === '\n') {
          finish()
          resolve(value)
          return
        }
        if (character === '\u007f') {
          value = value.slice(0, -1)
          continue
        }
        if (character >= ' ') value += character
      }
    }
    stdin.on('data', onData)
  })
}

export async function promptPassword(label: string): Promise<string> {
  while (true) {
    const value = await promptSecret(label)
    if (value.length >= 12) return value
    console.error('Use at least 12 characters.')
  }
}

export async function promptMultiple(label: string, choices: string[]): Promise<string[]> {
  if (choices.length === 0) return []
  console.log(label)
  choices.forEach((choice, index) => console.log(`  ${index + 1}. ${choice}`))
  while (true) {
    const raw = await line('Enter comma-separated numbers, or leave empty for none: ')
    if (!raw) return []
    const indexes = [...new Set(raw.split(',').map(value => Number(value.trim()) - 1))]
    if (indexes.every(index => Number.isInteger(index) && index >= 0 && index < choices.length)) {
      return indexes.map(index => choices[index]).filter((value): value is string => value !== undefined)
    }
    console.error('Select only numbers shown above.')
  }
}

export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}
