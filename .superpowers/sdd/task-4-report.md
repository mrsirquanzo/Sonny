# Task 4 Report: ModelRouter + Structured LLM Client

## What Was Implemented

- **`packages/core/src/model.ts`** — New file implementing:
  - `StructuredModel` interface: `generateStructured<T>(opts: { system, prompt, schema, model }) => Promise<T>`
  - `MODEL_ROUTER` constant mapping four roles to model IDs: `planner`, `specialist` (both `claude-opus-4-8`), `verifier` (`claude-sonnet-4-6`), `writer` (`claude-opus-4-8`)
  - `AnthropicModel` class implementing `StructuredModel`: reads `ANTHROPIC_API_KEY` from env (throws if absent), converts Zod schema to JSON Schema via `zod-to-json-schema`, calls Anthropic API with forced `tool_choice` (single "emit" tool), parses response back through Zod
- **`packages/core/src/model.test.ts`** — TDD test file covering all requirements (no network, uses FakeModel in-memory pattern)
- **`packages/core/src/index.ts`** — Added export line: `export { MODEL_ROUTER, AnthropicModel, type StructuredModel } from './model.js'`
- **`packages/core/package.json`** — Added `@anthropic-ai/sdk: ^0.37.0` and `zod-to-json-schema: ^3.24.1` to dependencies
- **`pnpm-lock.yaml`** — Updated by `pnpm install` (40 packages added)

## TDD Evidence

### RED — test fails before implementation

```
pnpm --filter @sonny/core test

 FAIL  src/model.test.ts [ src/model.test.ts ]
Error: Failed to load url ./model.js (resolved id: ./model.js) in ...model.test.ts. Does the file exist?

 Test Files  1 failed | 1 passed (2)
      Tests  2 passed (2)
```

### GREEN — all tests pass after implementation

```
pnpm --filter @sonny/core test

 ✓ src/evidenceStore.test.ts (2 tests) 1ms
 ✓ src/model.test.ts (7 tests) 2ms

 Test Files  2 passed (2)
      Tests  9 passed (9)
   Duration  329ms
```

## Files Changed

| File | Change |
|------|--------|
| `packages/core/src/model.ts` | Created (new) |
| `packages/core/src/model.test.ts` | Created (new) |
| `packages/core/src/index.ts` | Added export for model.ts |
| `packages/core/package.json` | Added two new dependencies |
| `pnpm-lock.yaml` | Updated by pnpm install |

## Commit

```
e902c7a feat(core): add StructuredModel interface, MODEL_ROUTER, and AnthropicModel
```

## Self-Review Notes

- **YAGNI respected**: No retry logic, no extra roles, no extra options beyond the brief spec.
- **Minimal SDK type casts**: One cast used for `input_schema` (`as Anthropic.Tool['input_schema']`), one for `zodToJsonSchema` return type. Both localized to the implementation, not leaking into the interface.
- **ESM .js extensions**: All local imports use `.js` extension as required for Node 20 ESM.
- **Test isolation**: `AnthropicModel` constructor-throws test restores `ANTHROPIC_API_KEY` via try/finally so it doesn't contaminate other tests.

## SDK Typing Concerns / Friction

- `zodToJsonSchema` returns `object` — required a cast to `Record<string, unknown>` to safely access `.definitions`. Minor friction, localized.
- `Anthropic.Tool['input_schema']` is typed as `{ type: 'object'; properties?: object; ... }` — the cast from the extracted JSON Schema sub-object works but is not verified at compile time. An alternative would be to use a stricter extraction, but the brief's reference implementation uses the same pattern.
- The `@anthropic-ai/sdk` version in the brief was `^0.30.0` but task instructions specified `^0.37.0` — used 0.37.0 as instructed.
