# zod-contract-hono

Wires a [Hono](https://hono.dev) app's `app.routes` table into
[zod-contract](../zod-contract)'s pipeline — produces OpenAPI `paths.yaml/json`
from your real, runtime routes, plus optional per-route Zod schemas for
query/body/response.

## Install

```bash
npm install --save-dev @aemrezorlu/zod-contract-hono hono zod
```

Peer deps: `hono` `^4.0.0`, `@aemrezorlu/zod-contract` `^0.3.0`, `@hono/zod-validator` `^0.4.0` (optional, for inline AST discovery).

## Inline `zValidator()` discovery (v0.2)

When a route file uses `@hono/zod-validator` with an inline schema, the plugin
walks the file's source via `ts-morph` and wires the validator up automatically:

```ts
// routes/users.post.ts
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'

export const CreateUser = z.object({ email: z.string().email(), name: z.string() })

export const POST = {
  validate: zValidator('json', CreateUser),
  handler: (c) => c.json({ id: 'new' }),
}
```

Result: `requestBody.content['application/json'].schema` is filled from `CreateUser`
— no separate `export const body = ...` needed. Targets supported: `'json'`, `'query'`,
`'param'`, `'header'`, `'cookie'`, `'form'`. Inline-only schemas (`z.object({...})` passed
directly) are out of scope — declare them as named exports.

## Usage

```ts
// src/server/app.ts
import { Hono } from 'hono'
export const app = new Hono()
  .get('/users', listUsers)
  .post('/users', createUser)
  .get('/users/:id', getUser)
```

```ts
// build.mjs
import { build } from '@aemrezorlu/zod-contract'
import { honoPlugin } from '@aemrezorlu/zod-contract-hono'

await build({
  src: 'src/api',                          // zod schemas (components/schemas)
  plugins: [honoPlugin({
    appEntry: 'src/server/app.ts',         // exports `app`
    routesDir: 'src/server/routes',        // optional: per-route Zod schemas
  })],
})
```

## Convention (when `routesDir` is set)

Mirrors [zod-contract-paths](../zod-contract-paths):

```
src/server/routes/users.get.ts         → GET /users
src/server/routes/users.post.ts        → POST /users
src/server/routes/users/[id].get.ts    → GET /users/:id
```

Each file exports any of:

```ts
import { z } from 'zod'

export const query     = z.object({ limit: z.coerce.number().int().optional() })
export const body      = z.object({ email: z.string().email() })
export const response  = z.object({ id: z.string() })
```

## Output

`paths.yaml` (or `paths.json` when the core is invoked with `--format json`):

```yaml
paths:
  /users:
    get:
      parameters:
        - name: limit
          in: query
          schema: ...
      responses: ...
  /users:
    post:
      requestBody: ...
```

## v0.1.0 scope

- Walks `app.routes` to discover `{ method, path }`
- Matches each route to a per-route schema file by `<rest>.<method>.ts` convention
- Honors `--format` from the core pipeline

Not yet (roadmap):
- AST-level discovery of `zValidator('json', schema)` / `zValidator('param', ...)` middleware in handler files
- Reverse-mapping existing Hono types from OpenAPI
- Multiple Hono apps in one project
