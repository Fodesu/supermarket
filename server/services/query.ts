import { HTTPError } from 'nitro'

function badRequest(message: string): never {
  throw new HTTPError(message, { statusCode: 400 })
}

export function scalarQuery(query: Record<string, unknown>, name: string) {
  const value = query[name]
  if (value == null) return undefined
  if (typeof value !== 'string') badRequest(`Query parameter "${name}" must be specified once`)
  return value.trim()
}

export function positiveIntegerQuery(value: string | undefined, name: string, maximum?: number) {
  if (value == null) return undefined
  if (!/^\d+$/.test(value)) badRequest(`Query parameter "${name}" must be a positive integer`)
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || (maximum != null && number > maximum)) {
    badRequest(`Query parameter "${name}" is out of range`)
  }
  return number
}
