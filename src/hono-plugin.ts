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
import { findInlineValidators } from './zvalidator-walker.js'

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
      const routesDir = opts.routesDir ? path.resolve(opts.routesDir) : undefined
      const fileIndex = routesDir ? await buildFileIndex(routesDir) : new Map<string, Record<string, unknown>>()
      const filePathIndex = routesDir ? await buildFilePathIndex(routesDir) : new Map<string, Record<string, string>>()

      const jiti = createJiti(routesDir ?? path.dirname(appPath), { interopDefault: true, moduleCache: false })

      const paths: Record<string, Record<string, OpenAPISchema>> = {}
      const tagByPath = (p: string): string[] | null => {
        const segs = p.split('/').filter(Boolean)
        const stemSegs = segs.filter((s) => !s.startsWith(':'))
        if (stemSegs.length < 2) return null
        const folder = stemSegs[stemSegs.length - 2]
        if (!folder || folder.startsWith(':')) return null
        return [folder]
      }
      for (const r of routes) {
        const fileKey = r.path
        const fileMod = fileIndex.get(fileKey)?.[r.method] ?? fileIndex.get(fileKey)
        const filePath = filePathIndex.get(fileKey)?.[r.method]

        // Resolution order: inline AST walker > named exports (query/body/response).
        const inline = filePath ? await augmentWithInlineValidators(r, fileMod, filePath, jiti) : null
        let operation: OpenAPISchema = inline ?? buildOperation(r, fileMod)

        // If only AST-filled, layer basic path params from the route path itself.
        if (inline) {
          const params: OpenAPIParameter[] = []
          for (const m of r.path.matchAll(/:(\w+)/g)) {
            params.push({ name: m[1]!, in: 'path', required: true, schema: { type: 'string' } })
          }
          const existingParams = (operation.parameters ?? []) as unknown as OpenAPIParameter[]
          const existingPathNames = new Set(existingParams.filter((p) => p.in === 'path').map((p) => p.name))
          for (const p of params) if (!existingPathNames.has(p.name)) existingParams.push(p)
          if (existingParams.length > 0) operation.parameters = existingParams as unknown as OpenAPISchema[]
        }

        const entry = paths[r.path] ?? {}
        const tags = tagByPath(r.path)
        if (tags) operation.tags = tags
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

async function augmentWithInlineValidators(
  route: ExtractedRoute,
  methodMod: unknown,
  filePath: string | undefined,
  jiti: ReturnType<typeof createJiti>,
): Promise<OpenAPISchema | null> {
  if (!filePath) return null
  const validators = await findInlineValidators(filePath)
  if (validators.length === 0) return null

  // Resolve schema refs via the jiti-loaded module exports.
  // jiti already cached the load; we re-load directly to grab the export map.
  const mod = jiti(filePath) as Record<string, unknown>

  // Pick validators that mention the exported schema names of this route's file,
  // and that are *not* already wired by exports (we layer them on top, exports win to keep tests stable).
  const op: OpenAPISchema = {}

  for (const v of validators) {
    const schema = mod[v.schemaName]
    if (!isZod(schema)) continue
    const z = schema as ZodTypeAny
    if (v.target === 'json' || v.target === 'form') {
      op.requestBody = {
        required: true,
        content:
          v.target === 'form'
            ? { 'multipart/form-data': { schema: zodToOpenAPI({ name: 'Body', zod: z, file: '' }) } }
            : { 'application/json': { schema: zodToOpenAPI({ name: 'Body', zod: z, file: '' }) } },
      }
    } else {
      // query / param / header / cookie → parameters
      const converted = zodToOpenAPI({ name: 'Params', zod: z, file: '' })
      const properties = (converted.properties ?? {}) as Record<string, OpenAPISchema>
      const required = (converted.required as string[] | undefined) ?? []
      const params: OpenAPIParameter[] = []
      const inLoc = v.target === 'param' ? 'path' : (v.target as 'query' | 'header' | 'cookie')
      // Path-level :name hints override schema for path params
      const pathHints = new Set<string>()
      for (const m of route.path.matchAll(/:(\w+)/g)) pathHints.add(m[1]!)
      for (const [name, schema] of Object.entries(properties)) {
        params.push({ name, in: inLoc, required: inLoc === 'path' ? true : required.includes(name), schema })
      }
      // Attach path params from route path even if no zValidator('param', ...) was used
      for (const hint of pathHints) {
        if (!params.find((p) => p.name === hint && p.in === 'path')) {
          params.push({ name: hint, in: 'path', required: true, schema: { type: 'string' } })
        }
      }
      // ponytail: dropping already-present exports of the same target/in-pair would need merging — accept duplicates for v0.2 (emitting both is legal in OpenAPI)
      op.parameters = params as unknown as OpenAPISchema[]
    }
  }

  return Object.keys(op).length > 0 ? op : null
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
    // Tier 1 #2: surface schema.describe() on the operation too
    const d = (z as { _def?: { description?: unknown } })._def?.description
    if (typeof d === 'string' && d.length > 0 && !operation.description) {
      operation.description = d
    }
  }

  return operation
}

// File path index: OpenAPI path → { [method]: absolute file path } (for AST walking).
async function buildFilePathIndex(routesDir: string): Promise<Map<string, Record<string, string>>> {
  const index = new Map<string, Record<string, string>>()
  let stat
  try {
    stat = await fs.stat(routesDir)
  } catch {
    return index
  }
  if (!stat.isDirectory()) return index

  const files = await walk(routesDir)
  const re = new RegExp(`^(.+)\\.(${METHODS.join('|')})\\.ts$`)

  for (const file of files) {
    const rel = path.relative(routesDir, file).replace(/\\/g, '/')
    const match = rel.match(re)
    if (!match) continue
    const [, rest, method] = match
    if (!rest || !method) continue
    const openapiPath = '/' + rest.replace(/\[([^\]]+)\]/g, ':$1')
    const methodMap = index.get(openapiPath) ?? {}
    methodMap[method.toLowerCase()] = file
    index.set(openapiPath, methodMap)
  }
  return index
}

function hasAnyZodExport(mod: unknown): boolean {
  if (typeof mod !== 'object' || mod === null) return false
  for (const [, v] of Object.entries(mod as Record<string, unknown>)) {
    if (isZod(v)) return true
  }
  return false
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
