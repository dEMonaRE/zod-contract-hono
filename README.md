# zod-contract-hono

Wires a [Hono](https://hono.dev) app's `app.routes` table into
[zod-contract](../zod-contract)'s pipeline — produces OpenAPI `paths.yaml/json`
from your real, runtime routes, plus optional per-route Zod schemas for
query/body/response.

## Install

```bash
npm install --save-dev @aemrezorlu/zod-contract-hono hono zod
```

Peer deps: `hono` `^4.0.0`, `@aemrezorlu/zod-contract` `^0.1.0`.

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
