import { z } from 'zod'

export const query = z.object({ limit: z.coerce.number().int().optional() })
export const response = z.object({ users: z.array(z.object({ id: z.string() })) })

export default async (c: { json: (x: unknown) => Response }) => c.json([])
