# Local Model Backend (Ollama) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the entire deep-research pipeline on local models (qwen2.5:14b for synthesis, llama3.1:8b for verification) for free, fast iteration - switchable to Anthropic by one environment variable, with cross-family verifier decorrelation preserved.

**Architecture:** Add an `OllamaModel` implementation of the existing `StructuredModel` interface that calls Ollama's `/api/chat` with JSON-schema structured outputs (built from the same `zod-to-json-schema` the Anthropic path uses, fully inlined so Ollama needs no `$ref` resolution). Make `MODEL_ROUTER` and a new `makeModel()` factory backend-aware via the `SONNY_BACKEND` env var, defaulting to `ollama` (building/optimization) with `anthropic` for demo/quality runs. Wire the CLI to `makeModel()`. No core orchestration logic changes - only the model layer and the CLI call site. Sub-project 1, slice 4 of the engine spec (`docs/specs/2026-06-28-sonny-deep-research-engine-design.md`); strengthens the spec's model-governance / BYO-key production story.

**Tech Stack:** TypeScript ESM monorepo (pnpm workspaces, Node 20+), Vitest, Zod, `zod-to-json-schema`, `@anthropic-ai/sdk`, Ollama 0.30+ (local), `tsx` CLI.

## Global Constraints

- ESM only: every relative import ends in `.js`; every package is `"type": "module"`.
- Package exports are source-first (`exports`/`main` point at `./src`).
- TDD: failing test first, watch it fail, implement minimally, watch it pass, commit.
- Structured output only: models return data via a Zod schema; never parse free text with regex (JSON.parse of a model's structured-output response, then `schema.parse`, is the structured path - not regex).
- Decorrelation preserved: the verifier role must resolve to a DIFFERENT model than the specialist. Anthropic: specialist `claude-opus-4-8`, verifier `claude-sonnet-4-6`. Ollama: specialist `qwen2.5:14b`, verifier `llama3.1:8b`.
- `SONNY_BACKEND` selects the backend: `ollama` (default) or `anthropic`. Both `MODEL_ROUTER` (role->model-id) and `makeModel()` (which `StructuredModel` instance) must agree on the backend.
- Tools/models accept an injectable `fetchImpl` so tests never hit the network or a local server.
- Copy rule: no em dash characters anywhere in code, comments, or output; use a plain hyphen. This includes commit messages and subjects (no task numbers in subjects).
- Run one package's tests with `pnpm --filter <pkg> test <name>`; the whole suite with `pnpm -r test`.

---

## File Structure

- `packages/core/src/ollamaModel.ts` (create) - `OllamaModel implements StructuredModel`.
- `packages/core/src/model.ts` (modify) - `Backend`, `currentBackend`, `routerFor`, backend-aware `MODEL_ROUTER`, `makeModel`.
- `packages/core/src/index.ts` (modify) - export `OllamaModel`, `makeModel`, `currentBackend`, `routerFor`.
- `apps/cli/src/deep.ts` (modify) - use `makeModel()` instead of `new AnthropicModel()`.
- Tests alongside.

---

### Task 1: OllamaModel

**Files:**
- Create: `packages/core/src/ollamaModel.ts`
- Test: `packages/core/src/ollamaModel.test.ts`

**Interfaces:**
- Consumes: `StructuredModel` from `./model.js`, `zodToJsonSchema`, `ZodType`.
- Produces: `class OllamaModel implements StructuredModel`. Constructor `constructor(opts?: { baseUrl?: string; fetchImpl?: typeof fetch })` (baseUrl defaults to `process.env.OLLAMA_HOST ?? 'http://localhost:11434'`). `generateStructured<T>({ system, prompt, schema, model })` POSTs to `${baseUrl}/api/chat` with the fully-inlined JSON schema as `format`, `stream: false`, `options: { temperature: 0 }`, then `JSON.parse`es `message.content` and validates with `schema.parse`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/ollamaModel.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { OllamaModel } from './ollamaModel.js';

const Schema = z.object({ verdict: z.string(), score: z.number() });

describe('OllamaModel', () => {
  it('calls Ollama /api/chat with the schema as format and parses the structured content', async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const fakeFetch = (async (url, init) => {
      captured = { url: String(url), body: JSON.parse(String((init as RequestInit).body)) };
      return new Response(JSON.stringify({ message: { content: '{"verdict":"go","score":0.9}' } }), { status: 200 });
    }) as unknown as typeof fetch;

    const model = new OllamaModel({ baseUrl: 'http://localhost:11434', fetchImpl: fakeFetch });
    const out = await model.generateStructured({ system: 'sys', prompt: 'pr', schema: Schema, model: 'qwen2.5:14b' });

    expect(out).toEqual({ verdict: 'go', score: 0.9 });
    expect(captured!.url).toBe('http://localhost:11434/api/chat');
    expect(captured!.body.model).toBe('qwen2.5:14b');
    expect(captured!.body.stream).toBe(false);
    expect(captured!.body.format).toBeTypeOf('object'); // a JSON schema object, not a string
    const messages = captured!.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(messages[1]).toEqual({ role: 'user', content: 'pr' });
  });

  it('throws on a non-ok response', async () => {
    const fakeFetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const model = new OllamaModel({ fetchImpl: fakeFetch });
    await expect(model.generateStructured({ system: 's', prompt: 'p', schema: Schema, model: 'qwen2.5:14b' }))
      .rejects.toThrow(/Ollama HTTP 500/);
  });

  it('throws when the content is not valid JSON for the schema', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ message: { content: '{"verdict":"go"}' } }), { status: 200 })) as unknown as typeof fetch;
    const model = new OllamaModel({ fetchImpl: fakeFetch });
    await expect(model.generateStructured({ system: 's', prompt: 'p', schema: Schema, model: 'qwen2.5:14b' }))
      .rejects.toThrow(); // missing required "score"
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/core test ollamaModel`
Expected: FAIL - module does not exist.

- [ ] **Step 3: Implement**

`packages/core/src/ollamaModel.ts`:

```ts
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodType } from 'zod';
import type { StructuredModel } from './model.js';

export class OllamaModel implements StructuredModel {
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.baseUrl = opts.baseUrl ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async generateStructured<T>(opts: {
    system: string; prompt: string; schema: ZodType<T>; model: string;
  }): Promise<T> {
    // Fully inline the schema ($refStrategy 'none') so Ollama's structured-output
    // engine needs no $ref resolution.
    const format = zodToJsonSchema(opts.schema as ZodType<unknown>, { $refStrategy: 'none' }) as Record<string, unknown>;

    const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.prompt },
        ],
        format,
        stream: false,
        options: { temperature: 0 },
      }),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);

    const data = (await res.json()) as { message?: { content?: string } };
    const content = data.message?.content;
    if (!content) throw new Error('Ollama returned no message content');
    return opts.schema.parse(JSON.parse(content));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sonny/core test ollamaModel`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/ollamaModel.ts packages/core/src/ollamaModel.test.ts
git commit -m "feat(core): OllamaModel - structured output via Ollama /api/chat"
```

---

### Task 2: Backend-aware routing and factory

**Files:**
- Modify: `packages/core/src/model.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/model.test.ts`

**Interfaces:**
- Consumes: `OllamaModel`, `AnthropicModel`, `StructuredModel`.
- Produces:
  - `type Backend = 'ollama' | 'anthropic'`
  - `currentBackend(): Backend` - reads `SONNY_BACKEND`, defaults to `'ollama'`; only the exact string `'anthropic'` selects Anthropic.
  - `routerFor(b: Backend): { planner: string; specialist: string; verifier: string; writer: string }` - the role->model-id map per backend.
  - `MODEL_ROUTER` - now `routerFor(currentBackend())` (evaluated at module load; reflects the process's backend). Existing consumers (`MODEL_ROUTER.specialist`, etc.) are unchanged.
  - `makeModel(): StructuredModel` - returns `new OllamaModel()` or `new AnthropicModel()` per `currentBackend()` (read at call time).

- [ ] **Step 1: Write the failing test**

`packages/core/src/model.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { routerFor, currentBackend, makeModel } from './model.js';
import { OllamaModel } from './ollamaModel.js';
import { AnthropicModel } from './model.js';

const original = process.env.SONNY_BACKEND;
afterEach(() => { if (original === undefined) delete process.env.SONNY_BACKEND; else process.env.SONNY_BACKEND = original; });

describe('backend routing', () => {
  it('routerFor maps roles per backend with cross-family verifier decorrelation', () => {
    const ollama = routerFor('ollama');
    expect(ollama.specialist).toBe('qwen2.5:14b');
    expect(ollama.verifier).toBe('llama3.1:8b');
    expect(ollama.specialist).not.toBe(ollama.verifier);
    const anth = routerFor('anthropic');
    expect(anth.specialist).toBe('claude-opus-4-8');
    expect(anth.verifier).toBe('claude-sonnet-4-6');
    expect(anth.specialist).not.toBe(anth.verifier);
  });

  it('defaults to ollama and only "anthropic" selects anthropic', () => {
    delete process.env.SONNY_BACKEND;
    expect(currentBackend()).toBe('ollama');
    process.env.SONNY_BACKEND = 'anthropic';
    expect(currentBackend()).toBe('anthropic');
    process.env.SONNY_BACKEND = 'something-else';
    expect(currentBackend()).toBe('ollama');
  });

  it('makeModel returns the backend-matching instance', () => {
    delete process.env.SONNY_BACKEND;
    expect(makeModel()).toBeInstanceOf(OllamaModel);
    process.env.SONNY_BACKEND = 'anthropic';
    expect(makeModel()).toBeInstanceOf(AnthropicModel);
  });
});
```

Note: the `makeModel` anthropic case constructs `AnthropicModel`, whose constructor requires `ANTHROPIC_API_KEY`. Set a dummy in the test environment so construction succeeds without a real key:

```ts
// at top of file, before the describe block
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'test-key-not-used';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/core test model`
Expected: FAIL - `routerFor`/`currentBackend`/`makeModel` not exported.

- [ ] **Step 3: Implement**

In `packages/core/src/model.ts`, replace the `MODEL_ROUTER` const block with backend-aware definitions and add the factory. Add an `OllamaModel` import at the top:

```ts
import { OllamaModel } from './ollamaModel.js';
```

Replace:

```ts
export const MODEL_ROUTER = {
  planner: 'claude-opus-4-8',
  specialist: 'claude-opus-4-8',
  verifier: 'claude-sonnet-4-6',
  writer: 'claude-opus-4-8',
} as const;
```

with:

```ts
export type Backend = 'ollama' | 'anthropic';

export interface RoleRouter { planner: string; specialist: string; verifier: string; writer: string }

const ROUTERS: Record<Backend, RoleRouter> = {
  anthropic: { planner: 'claude-opus-4-8', specialist: 'claude-opus-4-8', verifier: 'claude-sonnet-4-6', writer: 'claude-opus-4-8' },
  ollama: { planner: 'qwen2.5:14b', specialist: 'qwen2.5:14b', verifier: 'llama3.1:8b', writer: 'qwen2.5:14b' },
};

export function routerFor(b: Backend): RoleRouter { return ROUTERS[b]; }

export function currentBackend(): Backend {
  return process.env.SONNY_BACKEND === 'anthropic' ? 'anthropic' : 'ollama';
}

// Evaluated at module load - reflects the backend the process was launched with.
export const MODEL_ROUTER: RoleRouter = routerFor(currentBackend());
```

Then add `makeModel` at the end of the file (after the `AnthropicModel` class, so both classes are in scope):

```ts
export function makeModel(): StructuredModel {
  return currentBackend() === 'ollama' ? new OllamaModel() : new AnthropicModel();
}
```

In `packages/core/src/index.ts`, update the model export line to add the new symbols:

```ts
export { MODEL_ROUTER, AnthropicModel, makeModel, currentBackend, routerFor, type StructuredModel, type Backend } from './model.js';
export { OllamaModel } from './ollamaModel.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sonny/core test model`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/model.ts packages/core/src/index.ts packages/core/src/model.test.ts
git commit -m "feat(core): backend-aware model router and makeModel factory (ollama default)"
```

---

### Task 3: Wire the CLI to the backend factory

**Files:**
- Modify: `apps/cli/src/deep.ts`
- Test: `apps/cli/src/deep.test.ts`

**Interfaces:**
- Consumes: `makeModel`, `currentBackend` from `@sonny/core`.
- Produces: `runDeep` builds its three models with `makeModel()` and prints a one-line banner naming the active backend.

- [ ] **Step 1: Write the failing test**

Add to `apps/cli/src/deep.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { currentBackend } from '@sonny/core';

describe('deep backend default', () => {
  it('defaults to the local ollama backend when SONNY_BACKEND is unset', () => {
    const saved = process.env.SONNY_BACKEND;
    delete process.env.SONNY_BACKEND;
    expect(currentBackend()).toBe('ollama');
    if (saved !== undefined) process.env.SONNY_BACKEND = saved;
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @sonny/cli test deep`
Expected: FAIL - `currentBackend` is not yet exported/imported through `@sonny/core` in the CLI's resolution until Task 2 is built; if Task 2 is already merged this asserts the default. (If it passes immediately because Task 2 is in place, proceed - the behavior is what matters.)

- [ ] **Step 3: Implement**

In `apps/cli/src/deep.ts`, change the import line:

```ts
import { makeModel, currentBackend, produceBriefing, RESEARCH_ROSTER } from '@sonny/core';
```

(Remove `AnthropicModel` from the import.)

Replace the three model instances and add a backend banner at the top of `runDeep`:

```ts
export async function runDeep(target: string): Promise<void> {
  const t = target.trim() || 'CDCP1';
  process.stdout.write(`backend: ${currentBackend()}\n`);
  const briefing = await produceBriefing({
    target: t, roster: RESEARCH_ROSTER,
    literatureTools: [europePmcSearchTool, pmcFullTextTool],
    structuredTools: [openTargetsTargetTool, clinicalTrialsTool],
    specialistModel: makeModel(), verifierModel: makeModel(), leadModel: makeModel(),
    emit: (e) => process.stdout.write(formatTrace([e]) + '\n'),
    budget: { maxRounds: 4 },
  });
```

(The rest of `runDeep` - the rendering - is unchanged.)

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @sonny/cli test deep`
Expected: PASS.

- [ ] **Step 5: Full suite**

Run: `pnpm -r test`
Expected: every package green.

- [ ] **Step 6: Live smoke (now free - local)**

With Ollama running and `qwen2.5:14b` + `llama3.1:8b` pulled:
```bash
pnpm --filter @sonny/cli exec tsx src/index.ts deep CDCP1
```
Expected: `backend: ollama`, structured seeding, five specialists, full-text reads, completeness verdict, weighing, and a conclusion-first GO/WATCH/NO-GO briefing - all on local models, no API cost. This is also the first end-to-end validation of the Plan 2/3 tail stages (completeness -> gap-fill -> weighing -> recommendation).

Watch specifically for: Ollama structured-output schema acceptance on the nested claims schema (the inlined `format`), and whether grounded citations survive verification on llama3.1:8b. Record any quality or schema issues for the optimization pass; they are findings, not blockers for this slice (the slice's deliverable is the working swappable backend).

Demo/quality run (for comparison, costs API):
```bash
SONNY_BACKEND=anthropic ANTHROPIC_API_KEY=… pnpm --filter @sonny/cli exec tsx src/index.ts deep CDCP1
```

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/deep.ts apps/cli/src/deep.test.ts
git commit -m "feat(cli): run on the configured backend via makeModel (ollama default, anthropic for demo)"
```

---

## What this plan deliberately does NOT do (next plans)

- **Switch the web app** to `makeModel()` - the web glass-box is its own later plan; it still runs the old `runDossier`.
- **Prompt/flow optimization for local models** - this slice delivers the swappable backend; tuning prompts so qwen2.5:14b/llama3.1:8b hit a useful quality bar is the follow-on work the backend enables.
- **The slice-1/2/3 cleanup list** (OA-gate tightening, shared `DeepResearchOptions` type, etc.).

---

## Self-Review

- **Spec coverage (local backend):** `OllamaModel` structured output (Task 1), backend-aware `MODEL_ROUTER` + `makeModel` with `ollama` default and preserved cross-family decorrelation (Task 2), CLI wired to the factory with a backend banner and a free local live smoke (Task 3). Web switch and prompt optimization explicitly deferred above.
- **Placeholder scan:** none - every step carries real code and a concrete command with expected result.
- **Type consistency:** `OllamaModel` (Task 1) implements `StructuredModel` and is consumed by `makeModel` (Task 2); `Backend`/`RoleRouter`/`routerFor`/`currentBackend`/`MODEL_ROUTER`/`makeModel` defined in Task 2 are consumed by the CLI (Task 3); `MODEL_ROUTER` keeps the same `{ planner, specialist, verifier, writer }` shape so existing core consumers are unchanged.
