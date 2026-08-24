export function parseEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index < 1) continue
    const key = line.slice(0, index)
    let value = line.slice(index + 1)
    if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replaceAll("'\\''", "'")
    }
    values[key] = value
  }
  return values
}

export function quoteEnv(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function serializeEnv(values: Record<string, string>): string {
  return `${Object.entries(values).map(([key, value]) => `${key}=${quoteEnv(value)}`).join('\n')}\n`
}

export function redact(text: string, secrets: string[]): string {
  return secrets.filter(secret => secret.length >= 4).reduce(
    (result, secret) => result.replaceAll(secret, '[REDACTED]'),
    text
  )
}
