// Hono app → OpenAPI paths.
//
// Usage:
//   await build({
//     src: 'src/api',           // zod schemas (components/schemas)
//     plugins: [honoPlugin({
//       appEntry: 'src/server/app.ts',    // exports `app: Hono`
//       routesDir: 'src/server/routes',   // optional: per-route schemas
//     })],
//   })
//
// Convention (when routesDir is set): same as zod-contract-paths:
//   <dir>/<rest>.<method>.ts
//   users.get.ts         → GET /users
//   users/[id].get.ts    → GET /users/:id
// Files export any of: query, body, response (Zod schemas).

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createJiti } from 'jiti'
import { stringify as yaml } from 'yaml'
import type { ZodTypeAny } from 'zod'
import {
  zodToOpenAPI,
  type BuildContext,
  type OpenAPISchema,
  type Plugin,
} from '@aemrezorlu/zod-contract'

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const

export interface HonoPluginOptions {
  /** File exporting `app: Hono`. Loaded via jiti. */
  appEntry: string
  /** Directory of per-route schema files (same convention as zod-contract-paths). */
  routesDir?: string
}

export function honoPlugin(opts: HonoPluginOptions): Plugin {
  return {
    name: 'hono',
    async finalize(ctx: BuildContext): Promise<BuildContext> {
      // jiti-load the Hono app
      const appPath = path.resolve(opts.appEntry)
      let app: unknown
      try {
        const jiti = createJiti(path.dirname(appPath), {
          interopDefault: true,
          moduleCache: false,
        })
        const mod = jiti(appPath) as Record<string, unknown>
        app = mod.app ?? mod.default
      } catch (e) {
        process.stderr.write(`hono: failed to load ${opts.appEntry}: ${(e as Error).message}\n`)
        return ctx
      }

      const routes = extractRoutes(app)
      if (routes.length === 0) return ctx

      // Build route-file index if routesDir is given
      const fileIndex = opts.routesDir ? await buildFileIndex(path.resolve(opts.routesDir)) : new Map<string, Record<string, unknown>>()

      const paths: Record<string, Record<string, OpenAPISchema>> = {}
      for (const r of routes) {
        const fileKey = r.path
        const fileMod = fileIndex.get(fileKey)?.[r.method] ?? fileIndex.get(fileKey)
        const operation: OpenAPISchema = buildOperation(r, fileMod)
        const entry = paths[r.path] ?? {}
        entry[r.method] = operation
        paths[r.path] = entry
      }

      const ext = ctx.format === 'json' ? 'json' : 'yaml'
      const payload = { paths }
      const content =
        ctx.format === 'json' ? JSON.stringify(payload, null, 2) + '\n' : yaml(payload)
      ctx.outputs.set(`paths.${ext}`, content)
      return ctx
    },
  }
}

interface ExtractedRoute {
  path: string
  method: string
}

function extractRoutes(app: unknown): ExtractedRoute[] {
  const out: ExtractedRoute[] = []
  if (typeof app !== 'object' || app === null) return out
  const routes = (app as { routes?: unknown }).routes
  if (!Array.isArray(routes)) return out
  for (const r of routes) {
    if (typeof r !== 'object' || r === null) continue
    const route = r as { method?: unknown; path?: unknown }
    if (typeof route.method !== 'string' || typeof route.path !== 'string') continue
    out.push({ method: route.method.toLowerCase(), path: route.path })
  }
  return out
}

// File index: route path → { [method]: module exports }
// Convention: <routesDir>/<rest>.<method>.ts (same as paths-plugin)
async function buildFileIndex(routesDir: string): Promise<Map<string, Record<string, unknown>>> {
  const index = new Map<string, Record<string, unknown>>()
  let stat
  try {
    stat = await fs.stat(routesDir)
  } catch {
    return index
  }
  if (!stat.isDirectory()) return index

  const files = await walk(routesDir)
  const jiti = createJiti(routesDir, { interopDefault: true, moduleCache: false })
  const re = new RegExp(`^(.+)\\.(${METHODS.join('|')})\\.ts$`)

  for (const file of files) {
    const rel = path.relative(routesDir, file).replace(/\\/g, '/')
    const match = rel.match(re)
    if (!match) continue
    const [, rest, method] = match
    if (!rest || !method) continue
    const openapiPath = '/' + rest.replace(/\[([^\]]+)\]/g, ':$1')
    try {
      const mod = jiti(file) as Record<string, unknown>
      const methodMap = index.get(openapiPath) ?? {}
      methodMap[method.toLowerCase()] = mod
      index.set(openapiPath, methodMap)
    } catch {
      // skip files that fail to load — they may depend on runtime context
    }
  }
  return index
}

function buildOperation(route: ExtractedRoute, mod: unknown): OpenAPISchema {
  const operation: OpenAPISchema = {}
  if (typeof mod !== 'object' || mod === null) return operation

  // Path params auto-derived from /:name in route path
  const parameters: OpenAPIParameter[] = []
  for (const m of route.path.matchAll(/:(\w+)/g)) {
    parameters.push({ name: m[1]!, in: 'path', required: true, schema: { type: 'string' } })
  }

  if (isZod((mod as Record<string, unknown>).query)) {
    const z = (mod as Record<string, unknown>).query as ZodTypeAny
    const converted = zodToOpenAPI({ name: 'Params', zod: z, file: '' })
    const properties = (converted.properties ?? {}) as Record<string, OpenAPISchema>
    const required = (converted.required as string[] | undefined) ?? []
    for (const [name, schema] of Object.entries(properties)) {
      parameters.push({ name, in: 'query', required: required.includes(name), schema })
    }
  }

  if (parameters.length > 0) {
    // ponytail: see paths-plugin — same OpenAPI vs JSON Schema required cast at boundary
    operation.parameters = parameters as unknown as OpenAPISchema[]
  }

  if (isZod((mod as Record<string, unknown>).body)) {
    const z = (mod as Record<string, unknown>).body as ZodTypeAny
    operation.requestBody = {
      required: true,
      content: {
        'application/json': {
          schema: zodToOpenAPI({ name: 'Body', zod: z, file: '' }),
        },
      },
    }
  }

  if (isZod((mod as Record<string, unknown>).response)) {
    const z = (mod as Record<string, unknown>).response as ZodTypeAny
    operation.responses = {
      '200': {
        description: 'OK',
        content: {
          'application/json': {
            schema: zodToOpenAPI({ name: 'Response', zod: z, file: '' }),
          },
        },
      },
    }
  }

  return operation
}

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const out: string[] = []
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(full)))
    else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      out.push(full)
    }
  }
  return out
}

interface OpenAPIParameter {
  name: string
  in: 'path' | 'query' | 'header' | 'cookie'
  required: boolean
  schema: OpenAPISchema
}

function isZod(v: unknown): v is ZodTypeAny {
  if (typeof v !== 'object' || v === null) return false
  const def = (v as { _def?: unknown })._def
  if (typeof def !== 'object' || def === null) return false
  return typeof (def as { typeName?: unknown }).typeName === 'string'
}
