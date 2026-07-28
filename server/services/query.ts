import { HTTPError } from 'nitro'
import { z } from 'zod'

function badRequest(message: string): never {
  throw new HTTPError(message, { statusCode: 400 })
}

const scalarSchema = z.union([
  z.string().transform((value) => value.trim()),
  z.null().transform(() => undefined),
  z.undefined(),
])

export function scalarQuery(query: Record<string, unknown>, name: string) {
  const result = scalarSchema.safeParse(query[name])
  if (!result.success) badRequest(`Query parameter "${name}" must be specified once`)
  return result.data
}

export function positiveIntegerQuery(value: string | undefined, name: string, maximum?: number) {
  if (value == null) return undefined
  const schema = z.string()
    .regex(/^\d+$/, `Query parameter "${name}" must be a positive integer`)
    .transform(Number)
    .refine(
      (number) => Number.isSafeInteger(number) && number >= 1 && (maximum == null || number <= maximum),
      `Query parameter "${name}" is out of range`,
    )
  const result = schema.safeParse(value)
  if (!result.success) badRequest(result.error.issues[0]!.message)
  return result.data
}
