import type { Context } from 'hono'
export type RouteHandler = (c: Context) => Response | Promise<Response>
