import { Hono } from 'hono'

export const app = new Hono()
  .get('/users', (c) => c.json([]))
  .post('/users', (c) => c.json({}))
  .get('/users/:id', (c) => c.json({}))
