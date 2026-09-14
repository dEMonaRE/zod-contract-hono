import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import type { RouteHandler } from './_shared.js'

export const ListUsers = z.object({
  limit: z.coerce.number().int().optional(),
})

export const handler: RouteHandler = (c) => c.json([])
export const GET = { validate: zValidator('query', ListUsers), handler }
