// AST walker for `@hono/zod-validator` and similar `zValidator(target, schema)` call sites.
//
// Discovers inline validators like `zValidator('json', MyBody)` where MyBody
// is a top-level export in the same file. The plugin resolves the schema
// identifier via jiti-load of the module.

import * as fs from 'node:fs/promises'
import { Project, Node, SyntaxKind, type CallExpression, type Identifier } from 'ts-morph'

export type ValidatorTarget = 'json' | 'query' | 'param' | 'header' | 'cookie' | 'form'

export interface InlineValidator {
  target: ValidatorTarget
  /** Identifier of the schema export in the same file. */
  schemaName: string
}

/** Pull every `zValidator('<target>', <Ident>)` call from a single file's source. */
export async function findInlineValidators(filePath: string): Promise<InlineValidator[]> {
  const source = await fs.readFile(filePath, 'utf8')
  return findInlineValidatorsFromSource(source)
}

export function findInlineValidatorsFromSource(sourceText: string): InlineValidator[] {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false },
  })
  const sf = project.createSourceFile('inline.ts', sourceText)

  const out: InlineValidator[] = []
  sf.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return
    const call = node as CallExpression
    const expr = call.getExpression()
    if (!Node.isIdentifier(expr)) return
    if ((expr as Identifier).getText() !== 'zValidator') return

    const args = call.getArguments()
    if (args.length < 2) return

    const targetArg = args[0]
    const schemaArg = args[1]
    if (!targetArg || !schemaArg) return
    if (!Node.isStringLiteral(targetArg) && !Node.isNoSubstitutionTemplateLiteral(targetArg)) return

    const target = targetArg.getText().slice(1, -1) as ValidatorTarget
    if (!isValidTarget(target)) return

    // Accept only direct identifier refs (resolves via module exports).
    // Inline schemas (z.object({...})) are out of scope this iteration.
    const text = schemaArg.getText()
    const ident = text.match(/^[A-Za-z_$][A-Za-z0-9_$]*$/)?.[0]
    if (!ident) return

    out.push({ target, schemaName: ident })
  })
  return out
}

function isValidTarget(s: string): s is ValidatorTarget {
  return s === 'json' || s === 'query' || s === 'param' || s === 'header' || s === 'cookie' || s === 'form'
}
