import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import type { RouteHandler } from './_shared.js'

export const CreateUser = z.object({
  email: z.string().email(),
  name: z.string().min(1),
})

export const handler: RouteHandler = (c) => c.json({ id: 'new' })
export const POST = { validate: zValidator('json', CreateUser), handler }
