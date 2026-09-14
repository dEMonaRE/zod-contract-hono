import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { build } from '@aemrezorlu/zod-contract'
import { honoPlugin } from '../src/hono-plugin.js'

const APP = path.resolve('fixtures/server/app.ts')
const ROUTES = path.resolve('fixtures/routes')

async function tmp(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'zod-contract-hono-'))
}

describe('honoPlugin', () => {
  it('walks app.routes and emits paths.yaml with operation refs', async () => {
    const out = await tmp()
    const ctx = await build({
      src: APP, // dummy — fixtures dir here doesn't matter, only the plugin
      out,
      plugins: [honoPlugin({ appEntry: APP, routesDir: ROUTES })],
    })
    const yaml = ctx.outputs.get('paths.yaml')
    expect(yaml).toBeDefined()
    // three routes from app.ts
    expect(yaml).toContain('/users:')
    expect(yaml).toContain('get:')
    expect(yaml).toContain('post:')
    // paths uses /users/:id from app route table
    expect(yaml).toContain('/users/:id:')
    // schemas from routes/users.get.ts carry through
    expect(yaml).toContain('limit')
    expect(yaml).toContain('requestBody')
  })

  it('honors ctx.format=json', async () => {
    const out = await tmp()
    const ctx = await build({
      src: APP,
      out,
      plugins: [honoPlugin({ appEntry: APP, routesDir: ROUTES })],
      format: 'json',
    })
    expect(ctx.outputs.has('paths.yaml')).toBe(false)
    const json = ctx.outputs.get('paths.json')
    expect(json).toBeDefined()
    const parsed = JSON.parse(json!)
    expect(parsed.paths['/users'].get).toBeTruthy()
    expect(parsed.paths['/users'].post).toBeTruthy()
  })

  it('gracefully no-ops when appEntry fails to load', async () => {
    const out = await tmp()
    const ctx = await build({
      src: APP,
      out,
      plugins: [honoPlugin({ appEntry: '/nope/does-not-exist.ts' })],
    })
    expect(ctx.outputs.has('paths.yaml')).toBe(false)
  })

  it('walks routes without routesDir (just path/method skeleton)', async () => {
    const out = await tmp()
    const ctx = await build({
      src: APP,
      out,
      plugins: [honoPlugin({ appEntry: APP })],
    })
    const yaml = ctx.outputs.get('paths.yaml') ?? ''
    expect(yaml).toContain('/users')
    expect(yaml).toContain('/users/:id')
  })
})
