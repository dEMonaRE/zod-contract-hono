import { z } from 'zod'

export const body = z.object({ email: z.string().email(), name: z.string() })
export const response = z.object({ id: z.string() })

export default async (c: { json: (x: unknown) => Response }) => c.json({ id: 'new' })
