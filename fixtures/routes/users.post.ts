import { z } from 'zod'

export const body = z.object({
  email: z.string().email(),
  name: z.string().min(1),
})

export const response = z.object({
  id: z.string(),
  email: z.string().email(),
})
