import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { honoPlugin } from '../src/hono-plugin.js'
import type { BuildContext } from '@aemrezorlu/zod-contract'

const here = path.dirname(fileURLToPath(import.meta.url))

function makeCtx(): BuildContext {
  return { schemas: [], outputs: new Map(), format: 'yaml', openapiVersion: '3.2.0' }
}

describe('Hono zValidator AST discovery', () => {
  it('discovers inline zValidator(target, Schema) in route files', async () => {
    const plugin = honoPlugin({
      appEntry: path.resolve(here, '../fixtures/server/app.ts'),
      routesDir: path.resolve(here, '../fixtures/routes-zvalidator'),
    })
    const ctx = makeCtx()
    await plugin.finalize!(ctx)

    const parsed = parseYaml(ctx.outputs.get('paths.yaml')!) as {
      paths: Record<string, Record<string, { requestBody?: { content: { 'application/json': { schema: unknown } } }; parameters?: Array<{ name: string; in: string }> }>>
    }

    // GET /users — inline zValidator('query', ListUsers) → parameters from ListUsers
    const getUsers = parsed.paths['/users'].get
    expect(getUsers.parameters).toBeDefined()
    expect(getUsers.parameters!.find((p) => p.name === 'limit')).toBeDefined()

    // POST /users — inline zValidator('json', CreateUser) → requestBody from CreateUser
    const postUsers = parsed.paths['/users'].post
    expect(postUsers.requestBody).toBeDefined()
    const bodySchema = postUsers.requestBody!.content['application/json'].schema as {
      properties: Record<string, { type: string }>
      required: string[]
    }
    expect(bodySchema.properties.email).toMatchObject({ type: 'string', format: 'email' })
    expect(bodySchema.required).toEqual(expect.arrayContaining(['email', 'name']))
  })
})
