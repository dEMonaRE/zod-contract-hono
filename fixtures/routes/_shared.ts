// Shared handler signature for route files. Minimal so the AST walker
// has something to discover without needing the real @hono/node-server types.
import type { Context } from 'hono'

export type RouteHandler = (c: Context) => Response | Promise<Response>
