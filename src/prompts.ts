import { randomBytes } from 'node:crypto'
import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  password,
  select,
  text
} from '@clack/prompts'
import type { Option } from '@clack/prompts'

export class PromptCancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'PromptCancelledError'
  }
}

function resultOrCancel<T>(value: T | symbol): T {
  if (!isCancel(value)) return value
  cancel('Operation cancelled.')
  throw new PromptCancelledError()
}

export type PromptChoice<T extends string> = Option<T>

export function promptIntro(title: string): void {
  intro(title)
}

export function promptOutro(message: string): void {
  outro(message)
}

export function promptNote(message: string, title?: string): void {
  note(message, title)
}

export async function promptText(label: string, defaultValue?: string): Promise<string> {
  const value = await text({
    message: label,
    ...(defaultValue === undefined ? {} : { placeholder: defaultValue, defaultValue })
  })
  return resultOrCancel(value).trim()
}

export async function promptRequired(label: string, defaultValue?: string): Promise<string> {
  const value = await text({
    message: label,
    ...(defaultValue === undefined ? {} : { placeholder: defaultValue, defaultValue }),
    validate: input => input?.trim() ? undefined : 'A value is required.'
  })
  return resultOrCancel(value).trim()
}

export async function promptConfirm(label: string, defaultValue = true): Promise<boolean> {
  return resultOrCancel(await confirm({ message: label, initialValue: defaultValue }))
}

export async function promptNumber(label: string, defaultValue: number, validate?: (value: number) => boolean): Promise<number> {
  const value = await text({
    message: label,
    placeholder: String(defaultValue),
    defaultValue: String(defaultValue),
    validate: input => {
      const number = Number(input)
      if (!Number.isInteger(number) || (validate && !validate(number))) return 'Enter a valid number.'
      return undefined
    }
  })
  return Number(resultOrCancel(value))
}

export async function promptSecret(label: string): Promise<string> {
  return resultOrCancel(await password({
    message: label,
    validate: value => value ? undefined : 'A value is required.'
  }))
}

export async function promptPassword(label: string): Promise<string> {
  return resultOrCancel(await password({
    message: label,
    validate: value => (value?.length ?? 0) >= 12 ? undefined : 'Use at least 12 characters.'
  }))
}

export async function promptSelect<T extends string>(label: string, choices: PromptChoice<T>[], initialValue?: T): Promise<T> {
  const value = await select({
    message: label,
    options: choices,
    ...(initialValue === undefined ? {} : { initialValue })
  })
  return resultOrCancel(value)
}

export async function promptMultiple(label: string, choices: string[]): Promise<string[]> {
  if (choices.length === 0) return []
  const value = await multiselect({
    message: label,
    options: choices.map(choice => ({ value: choice, label: choice })),
    required: false
  })
  return resultOrCancel(value)
}

export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}
