# Sonny v2 — Grounded Core Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working, tested, end-to-end *grounded* pipeline: a Target-Biology question → orchestrator plans → calls real Open Targets + PubMed tools → registers evidence by canonical ID → a specialist drafts citation-bearing claims → a decorrelated verifier marks each claim supported/unsupported/overreach → synthesis assembles only verified, cited claims → streamed as a trace and printed by a CLI, with a faithfulness/recall eval harness.

**Architecture:** A pnpm/TypeScript monorepo. `packages/shared` holds Zod-validated data contracts (Evidence, Claim, Verdict, TraceEvent). `packages/core` is the trust engine (evidence store, ModelRouter + structured LLM client, grounding gate, decorrelated verifier, orchestrator). `packages/mcp-gateway` exposes data sources as tools that return normalized canonical `Evidence`. `apps/cli` wires it together; `eval/` scores faithfulness + recall. All LLM access is dependency-injected so the whole pipeline is unit-testable with fakes; only the CLI and an opt-in integration test hit the network.

**Tech Stack:** TypeScript (ESM), Node 20+, pnpm workspaces, Vitest, Zod, `zod-to-json-schema`, `@anthropic-ai/sdk`, native `fetch`.

## Global Constraints

- **Language/runtime:** TypeScript, ESM (`"type": "module"`), Node 20+. Exact: `"engines": { "node": ">=20" }`.
- **Trust rule (non-negotiable):** a factual `Claim` ships only if it carries ≥1 citation that resolves to a real `Evidence` id in the store ("no token, no ship"). Empty tool results register **zero** evidence — never fabricated.
- **Decorrelated verifier:** the verifier model MUST differ from the synthesizer model. Exact: synthesizer/specialist = `claude-opus-4-8`; verifier = `claude-sonnet-4-6`.
- **Canonical IDs:** Open Targets → `ENSG…`; PubMed → `PMID:<digits>`. Evidence is keyed by these verbatim.
- **BYO key:** the only required secret is `ANTHROPIC_API_KEY` (read from env; never logged). All data sources are free/public (no key).
- **No structured output via regex.** Models return data through the injected `StructuredModel.generateStructured(...)` (Zod-validated), never by parsing free text.
- **Testing:** Vitest. Unit tests inject fakes for models and `fetch`; no network in unit tests. Live calls only in `apps/cli` and tests tagged `@integration` (skipped without `ANTHROPIC_API_KEY`).
- **Commits:** conventional commits, one per task minimum.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.env.example`, `.gitignore`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `pnpm -r test`; the `@sonny/shared` package name other packages import.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/smoke.test.ts
import { describe, it, expect } from 'vitest';
import { PACKAGE_OK } from './index.js';

describe('scaffold', () => {
  it('loads the shared package', () => {
    expect(PACKAGE_OK).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -r test`
Expected: FAIL — `Cannot find module './index.js'` (file not yet created).

- [ ] **Step 3: Write the scaffold files**

```json
// package.json
{
  "name": "sonny",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": { "test": "pnpm -r test", "build": "pnpm -r build" },
  "devDependencies": { "typescript": "^5.5.0", "vitest": "^2.0.0", "zod-to-json-schema": "^3.23.0" }
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - "packages/*"
  - "apps/*"
```

```json
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "declaration": true, "esModuleInterop": true,
    "skipLibCheck": true, "forceConsistentCasingInFileNames": true
  }
}
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { globals: false, include: ['**/*.test.ts'] } });
```

```bash
# .env.example
ANTHROPIC_API_KEY=
```

```
# .gitignore
node_modules
dist
.env
.env.local
```

```json
// packages/shared/package.json
{
  "name": "@sonny/shared",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "build": "tsc -p tsconfig.json" },
  "dependencies": { "zod": "^3.23.0" }
}
```

```json
// packages/shared/tsconfig.json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
```

```ts
// packages/shared/src/index.ts
export const PACKAGE_OK = true;
```

- [ ] **Step 4: Install and run tests**

Run: `pnpm install && pnpm -r test`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm/ts monorepo with shared package"
```

---

### Task 2: Data contracts (Zod schemas) in `@sonny/shared`

**Files:**
- Modify: `packages/shared/src/index.ts`
- Create: `packages/shared/src/contracts.ts`
- Test: `packages/shared/src/contracts.test.ts`

**Interfaces:**
- Consumes: `zod`.
- Produces: types `Evidence`, `EvidenceKind`, `Claim`, `Verdict`, `VerdictStatus`, `TraceEvent`; schemas `EvidenceSchema`, `ClaimSchema`, `ClaimsSchema`, `VerdictSchema`. Used by every later task.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/contracts.test.ts
import { describe, it, expect } from 'vitest';
import { ClaimSchema, ClaimsSchema, EvidenceSchema, VerdictSchema } from './contracts.js';

describe('contracts', () => {
  it('accepts a valid evidence record', () => {
    const e = { id: 'ENSG00000146648', kind: 'target', source: 'Open Targets',
      title: 'EGFR', snippet: 'receptor tyrosine kinase', url: 'https://x', raw: {}, retrievedAt: '2026-06-27T00:00:00Z' };
    expect(EvidenceSchema.parse(e).id).toBe('ENSG00000146648');
  });

  it('rejects a claim with no citations array', () => {
    expect(() => ClaimSchema.parse({ id: 'c1', text: 'x', confidence: 0.5 })).toThrow();
  });

  it('parses a claims envelope', () => {
    const parsed = ClaimsSchema.parse({ claims: [{ id: 'c1', text: 'x', citations: ['PMID:1'], confidence: 0.9 }] });
    expect(parsed.claims).toHaveLength(1);
  });

  it('constrains verdict status', () => {
    expect(() => VerdictSchema.parse({ claimId: 'c1', status: 'maybe', rationale: 'r' })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/shared test`
Expected: FAIL — `Cannot find module './contracts.js'`.

- [ ] **Step 3: Write the contracts**

```ts
// packages/shared/src/contracts.ts
import { z } from 'zod';

export const EvidenceKindSchema = z.enum(['target', 'publication', 'trial', 'patent', 'dataset']);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const EvidenceSchema = z.object({
  id: z.string().min(1),
  kind: EvidenceKindSchema,
  source: z.string().min(1),
  title: z.string(),
  snippet: z.string(),
  url: z.string(),
  raw: z.unknown(),
  retrievedAt: z.string(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ClaimSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  citations: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const ClaimsSchema = z.object({ claims: z.array(ClaimSchema) });

export const VerdictStatusSchema = z.enum(['supported', 'unsupported', 'overreach']);
export type VerdictStatus = z.infer<typeof VerdictStatusSchema>;

export const VerdictSchema = z.object({
  claimId: z.string().min(1),
  status: VerdictStatusSchema,
  rationale: z.string(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export type TraceEvent =
  | { type: 'plan'; specialists: string[]; tools: string[] }
  | { type: 'tool_call'; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; count: number }
  | { type: 'evidence_registered'; id: string; title: string }
  | { type: 'claim_drafted'; claim: Claim }
  | { type: 'verdict'; verdict: Verdict }
  | { type: 'synthesis'; section: string }
  | { type: 'error'; message: string };
```

```ts
// packages/shared/src/index.ts
export const PACKAGE_OK = true;
export * from './contracts.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @sonny/shared test`
Expected: PASS (4 tests + the smoke test).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(shared): add Evidence/Claim/Verdict/TraceEvent contracts"
```

---

### Task 3: Evidence store (`@sonny/core`)

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/evidenceStore.ts`
- Test: `packages/core/src/evidenceStore.test.ts`

**Interfaces:**
- Consumes: `Evidence` from `@sonny/shared`.
- Produces: `class EvidenceStore` with `register(e: Evidence): void`, `get(id: string): Evidence | undefined`, `has(id: string): boolean`, `all(): Evidence[]`. Dedupes by `id` (first write wins).

- [ ] **Step 1: Create the package manifest**

```json
// packages/core/package.json
{
  "name": "@sonny/core",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "build": "tsc -p tsconfig.json" },
  "dependencies": { "@sonny/shared": "workspace:*", "zod": "^3.23.0" }
}
```

```json
// packages/core/tsconfig.json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/core/src/evidenceStore.test.ts
import { describe, it, expect } from 'vitest';
import type { Evidence } from '@sonny/shared';
import { EvidenceStore } from './evidenceStore.js';

const ev = (id: string): Evidence => ({
  id, kind: 'publication', source: 'PubMed', title: 't', snippet: 's', url: 'u', raw: {}, retrievedAt: 'now',
});

describe('EvidenceStore', () => {
  it('registers and retrieves by id', () => {
    const s = new EvidenceStore();
    s.register(ev('PMID:1'));
    expect(s.has('PMID:1')).toBe(true);
    expect(s.get('PMID:1')?.id).toBe('PMID:1');
  });

  it('dedupes by id (first write wins)', () => {
    const s = new EvidenceStore();
    s.register({ ...ev('PMID:1'), title: 'first' });
    s.register({ ...ev('PMID:1'), title: 'second' });
    expect(s.all()).toHaveLength(1);
    expect(s.get('PMID:1')?.title).toBe('first');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @sonny/core test`
Expected: FAIL — `Cannot find module './evidenceStore.js'`.

- [ ] **Step 4: Implement the store and package index**

```ts
// packages/core/src/evidenceStore.ts
import type { Evidence } from '@sonny/shared';

export class EvidenceStore {
  private readonly byId = new Map<string, Evidence>();
  register(e: Evidence): void { if (!this.byId.has(e.id)) this.byId.set(e.id, e); }
  get(id: string): Evidence | undefined { return this.byId.get(id); }
  has(id: string): boolean { return this.byId.has(id); }
  all(): Evidence[] { return [...this.byId.values()]; }
}
```

```ts
// packages/core/src/index.ts
export { EvidenceStore } from './evidenceStore.js';
```

- [ ] **Step 5: Run tests and commit**

Run: `pnpm --filter @sonny/core test` → Expected: PASS.

```bash
git add -A
git commit -m "feat(core): evidence store keyed by canonical id with dedupe"
```

---

### Task 4: ModelRouter + structured LLM client

**Files:**
- Create: `packages/core/src/model.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/package.json`
- Test: `packages/core/src/model.test.ts`

**Interfaces:**
- Consumes: `zod`, `zod-to-json-schema`, `@anthropic-ai/sdk`.
- Produces: `interface StructuredModel { generateStructured<T>(opts: { system: string; prompt: string; schema: ZodType<T>; model: string }): Promise<T> }`; `const MODEL_ROUTER = { planner, specialist, verifier, writer }` (string model ids); `class AnthropicModel implements StructuredModel`. Later tasks depend ONLY on the `StructuredModel` interface and `MODEL_ROUTER`.

- [ ] **Step 1: Add dependencies**

Edit `packages/core/package.json` dependencies to add: `"@anthropic-ai/sdk": "^0.30.0"`, `"zod-to-json-schema": "^3.23.0"`. Then run `pnpm install`.

- [ ] **Step 2: Write the failing test**

```ts
// packages/core/src/model.test.ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { MODEL_ROUTER, type StructuredModel } from './model.js';

describe('ModelRouter', () => {
  it('maps roles to distinct synth/verifier models', () => {
    expect(MODEL_ROUTER.specialist).toBe('claude-opus-4-8');
    expect(MODEL_ROUTER.verifier).toBe('claude-sonnet-4-6');
    expect(MODEL_ROUTER.verifier).not.toBe(MODEL_ROUTER.specialist);
  });

  it('StructuredModel contract returns a parsed object (fake impl)', async () => {
    const fake: StructuredModel = {
      async generateStructured({ schema }) { return schema.parse({ ok: true }); },
    };
    const out = await fake.generateStructured({ system: '', prompt: '', schema: z.object({ ok: z.boolean() }), model: 'x' });
    expect(out.ok).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @sonny/core test`
Expected: FAIL — `Cannot find module './model.js'`.

- [ ] **Step 4: Implement ModelRouter + AnthropicModel**

```ts
// packages/core/src/model.ts
import Anthropic from '@anthropic-ai/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodType } from 'zod';

export const MODEL_ROUTER = {
  planner: 'claude-opus-4-8',
  specialist: 'claude-opus-4-8',
  verifier: 'claude-sonnet-4-6',
  writer: 'claude-opus-4-8',
} as const;

export interface StructuredModel {
  generateStructured<T>(opts: { system: string; prompt: string; schema: ZodType<T>; model: string }): Promise<T>;
}

export class AnthropicModel implements StructuredModel {
  private client: Anthropic;
  constructor(apiKey = process.env.ANTHROPIC_API_KEY) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required');
    this.client = new Anthropic({ apiKey });
  }

  async generateStructured<T>(opts: { system: string; prompt: string; schema: ZodType<T>; model: string }): Promise<T> {
    const jsonSchema = zodToJsonSchema(opts.schema as ZodType<unknown>, 'Output') as Record<string, unknown>;
    const tool = {
      name: 'emit', description: 'Return the structured result.',
      input_schema: ((jsonSchema.definitions as Record<string, unknown>)?.Output ?? jsonSchema) as Anthropic.Tool.InputSchema,
    };
    const res = await this.client.messages.create({
      model: opts.model, max_tokens: 4096, system: opts.system,
      tools: [tool as Anthropic.Tool], tool_choice: { type: 'tool', name: 'emit' },
      messages: [{ role: 'user', content: opts.prompt }],
    });
    const block = res.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') throw new Error('model did not return structured output');
    return opts.schema.parse(block.input);
  }
}
```

```ts
// packages/core/src/index.ts
export { EvidenceStore } from './evidenceStore.js';
export { MODEL_ROUTER, AnthropicModel, type StructuredModel } from './model.js';
```

- [ ] **Step 5: Run tests and commit**

Run: `pnpm --filter @sonny/core test` → Expected: PASS (fake-impl test runs; no network).

```bash
git add -A
git commit -m "feat(core): ModelRouter + zod-driven structured Anthropic client"
```

---

### Task 5: Gateway tool interface + Open Targets tool

**Files:**
- Create: `packages/mcp-gateway/package.json`, `packages/mcp-gateway/tsconfig.json`, `packages/mcp-gateway/src/tool.ts`, `packages/mcp-gateway/src/openTargets.ts`, `packages/mcp-gateway/src/index.ts`
- Test: `packages/mcp-gateway/src/openTargets.test.ts`

**Interfaces:**
- Consumes: `Evidence` from `@sonny/shared`.
- Produces: `interface Tool { name: string; description: string; call(args: Record<string, unknown>, fetchImpl?: typeof fetch): Promise<Evidence[]> }`; `const openTargetsTool: Tool` (arg `{ symbol: string }`) returning a `kind: 'target'` Evidence keyed by `ENSG…`.

- [ ] **Step 1: Create manifests**

```json
// packages/mcp-gateway/package.json
{
  "name": "@sonny/mcp-gateway",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "build": "tsc -p tsconfig.json" },
  "dependencies": { "@sonny/shared": "workspace:*" }
}
```

```json
// packages/mcp-gateway/tsconfig.json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
```

- [ ] **Step 2: Write the failing test (with injected fake fetch)**

```ts
// packages/mcp-gateway/src/openTargets.test.ts
import { describe, it, expect } from 'vitest';
import { openTargetsTool } from './openTargets.js';

const fakeFetch = (async () =>
  new Response(JSON.stringify({
    data: { search: { hits: [{ id: 'ENSG00000146648', name: 'EGFR', entity: 'target',
      description: 'epidermal growth factor receptor' }] } },
  }), { status: 200 })) as unknown as typeof fetch;

describe('openTargetsTool', () => {
  it('normalizes a target hit to canonical ENSG evidence', async () => {
    const out = await openTargetsTool.call({ symbol: 'EGFR' }, fakeFetch);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('ENSG00000146648');
    expect(out[0].kind).toBe('target');
    expect(out[0].source).toBe('Open Targets');
    expect(out[0].title).toBe('EGFR');
  });

  it('returns zero evidence on empty hits (never fabricates)', async () => {
    const empty = (async () => new Response(JSON.stringify({ data: { search: { hits: [] } } }), { status: 200 })) as unknown as typeof fetch;
    expect(await openTargetsTool.call({ symbol: 'ZZZ' }, empty)).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @sonny/mcp-gateway test`
Expected: FAIL — `Cannot find module './openTargets.js'`.

- [ ] **Step 4: Implement the tool interface + Open Targets tool**

```ts
// packages/mcp-gateway/src/tool.ts
import type { Evidence } from '@sonny/shared';
export interface Tool {
  name: string;
  description: string;
  call(args: Record<string, unknown>, fetchImpl?: typeof fetch): Promise<Evidence[]>;
}
```

```ts
// packages/mcp-gateway/src/openTargets.ts
import type { Evidence } from '@sonny/shared';
import type { Tool } from './tool.js';

const ENDPOINT = 'https://api.platform.opentargets.org/api/v4/graphql';
const QUERY = `query Search($q: String!) {
  search(queryString: $q, entityNames: ["target"]) {
    hits { id name entity description }
  }
}`;

export const openTargetsTool: Tool = {
  name: 'open_targets_search',
  description: 'Resolve a gene symbol to its Open Targets target record (ENSG id, name, description).',
  async call(args, fetchImpl = fetch) {
    const symbol = String(args.symbol ?? '').trim();
    if (!symbol) return [];
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { q: symbol } }),
    });
    if (!res.ok) throw new Error(`Open Targets HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { search?: { hits?: Array<{ id: string; name: string; entity: string; description?: string }> } } };
    const hits = (json.data?.search?.hits ?? []).filter((h) => h.entity === 'target' && h.id.startsWith('ENSG'));
    const now = new Date().toISOString();
    return hits.slice(0, 1).map<Evidence>((h) => ({
      id: h.id, kind: 'target', source: 'Open Targets', title: h.name,
      snippet: h.description ?? '', url: `https://platform.opentargets.org/target/${h.id}`, raw: h, retrievedAt: now,
    }));
  },
};
```

```ts
// packages/mcp-gateway/src/index.ts
export type { Tool } from './tool.js';
export { openTargetsTool } from './openTargets.js';
```

- [ ] **Step 5: Run tests and commit**

Run: `pnpm --filter @sonny/mcp-gateway test` → Expected: PASS.

```bash
git add -A
git commit -m "feat(gateway): Tool interface + Open Targets tool with canonical ENSG normalization"
```

---

### Task 6: PubMed tool

**Files:**
- Create: `packages/mcp-gateway/src/pubmed.ts`
- Modify: `packages/mcp-gateway/src/index.ts`
- Test: `packages/mcp-gateway/src/pubmed.test.ts`

**Interfaces:**
- Consumes: `Tool`, `Evidence`.
- Produces: `const pubmedTool: Tool` (arg `{ query: string }`) returning `kind: 'publication'` Evidence keyed by `PMID:<digits>`.

- [ ] **Step 1: Write the failing test (injected fake fetch for both E-utilities calls)**

```ts
// packages/mcp-gateway/src/pubmed.test.ts
import { describe, it, expect } from 'vitest';
import { pubmedTool } from './pubmed.js';

const fakeFetch = (async (url: string | URL) => {
  const u = String(url);
  if (u.includes('esearch')) return new Response(JSON.stringify({ esearchresult: { idlist: ['29622564'] } }), { status: 200 });
  return new Response(JSON.stringify({ result: { uids: ['29622564'],
    '29622564': { uid: '29622564', title: 'EGFR mutations in NSCLC', source: 'J Onc', pubdate: '2018' } } }), { status: 200 });
}) as unknown as typeof fetch;

describe('pubmedTool', () => {
  it('normalizes a PubMed hit to canonical PMID evidence', async () => {
    const out = await pubmedTool.call({ query: 'EGFR NSCLC' }, fakeFetch);
    expect(out[0].id).toBe('PMID:29622564');
    expect(out[0].kind).toBe('publication');
    expect(out[0].title).toBe('EGFR mutations in NSCLC');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/mcp-gateway test`
Expected: FAIL — `Cannot find module './pubmed.js'`.

- [ ] **Step 3: Implement the PubMed tool**

```ts
// packages/mcp-gateway/src/pubmed.ts
import type { Evidence } from '@sonny/shared';
import type { Tool } from './tool.js';

const ESEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const ESUMMARY = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';

export const pubmedTool: Tool = {
  name: 'pubmed_search',
  description: 'Search PubMed and return publication records (PMID, title, source, year).',
  async call(args, fetchImpl = fetch) {
    const query = String(args.query ?? '').trim();
    if (!query) return [];
    const sres = await fetchImpl(`${ESEARCH}?db=pubmed&retmode=json&retmax=5&term=${encodeURIComponent(query)}`);
    if (!sres.ok) throw new Error(`PubMed esearch HTTP ${sres.status}`);
    const ids = (((await sres.json()) as { esearchresult?: { idlist?: string[] } }).esearchresult?.idlist) ?? [];
    if (ids.length === 0) return [];
    const ures = await fetchImpl(`${ESUMMARY}?db=pubmed&retmode=json&id=${ids.join(',')}`);
    if (!ures.ok) throw new Error(`PubMed esummary HTTP ${ures.status}`);
    const result = ((await ures.json()) as { result?: Record<string, { uid: string; title?: string; source?: string; pubdate?: string }> }).result ?? {};
    const now = new Date().toISOString();
    return ids.map<Evidence>((uid) => {
      const r = result[uid] ?? { uid };
      return {
        id: `PMID:${uid}`, kind: 'publication', source: 'PubMed', title: r.title ?? '(no title)',
        snippet: `${r.source ?? ''} ${r.pubdate ?? ''}`.trim(),
        url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`, raw: r, retrievedAt: now,
      };
    });
  },
};
```

```ts
// packages/mcp-gateway/src/index.ts
export type { Tool } from './tool.js';
export { openTargetsTool } from './openTargets.js';
export { pubmedTool } from './pubmed.js';
```

- [ ] **Step 4: Run tests and commit**

Run: `pnpm --filter @sonny/mcp-gateway test` → Expected: PASS.

```bash
git add -A
git commit -m "feat(gateway): PubMed tool with canonical PMID normalization"
```

---

### Task 7: Grounding gate

**Files:**
- Create: `packages/core/src/grounding.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/grounding.test.ts`

**Interfaces:**
- Consumes: `Claim` from `@sonny/shared`, `EvidenceStore`.
- Produces: `function groundClaims(claims: Claim[], store: EvidenceStore): { shippable: Claim[]; stripped: Array<{ claim: Claim; reason: string }> }`. A claim is shippable iff it has ≥1 citation AND every citation resolves in the store.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/grounding.test.ts
import { describe, it, expect } from 'vitest';
import type { Claim, Evidence } from '@sonny/shared';
import { EvidenceStore } from './evidenceStore.js';
import { groundClaims } from './grounding.js';

const ev = (id: string): Evidence => ({ id, kind: 'publication', source: 'PubMed', title: 't', snippet: 's', url: 'u', raw: {}, retrievedAt: 'now' });
const claim = (id: string, citations: string[]): Claim => ({ id, text: 'x', citations, confidence: 0.9 });

describe('groundClaims', () => {
  it('ships a claim whose citations all resolve', () => {
    const s = new EvidenceStore(); s.register(ev('PMID:1'));
    const r = groundClaims([claim('c1', ['PMID:1'])], s);
    expect(r.shippable).toHaveLength(1);
  });
  it('strips a claim with no citations', () => {
    const r = groundClaims([claim('c1', [])], new EvidenceStore());
    expect(r.shippable).toHaveLength(0);
    expect(r.stripped[0].reason).toMatch(/no citation/i);
  });
  it('strips a claim citing an unknown id', () => {
    const r = groundClaims([claim('c1', ['PMID:999'])], new EvidenceStore());
    expect(r.stripped[0].reason).toMatch(/does not resolve/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/core test`
Expected: FAIL — `Cannot find module './grounding.js'`.

- [ ] **Step 3: Implement the grounding gate**

```ts
// packages/core/src/grounding.ts
import type { Claim } from '@sonny/shared';
import type { EvidenceStore } from './evidenceStore.js';

export function groundClaims(
  claims: Claim[],
  store: EvidenceStore,
): { shippable: Claim[]; stripped: Array<{ claim: Claim; reason: string }> } {
  const shippable: Claim[] = [];
  const stripped: Array<{ claim: Claim; reason: string }> = [];
  for (const c of claims) {
    if (c.citations.length === 0) { stripped.push({ claim: c, reason: 'no citation' }); continue; }
    const unresolved = c.citations.filter((id) => !store.has(id));
    if (unresolved.length > 0) { stripped.push({ claim: c, reason: `citation does not resolve: ${unresolved.join(', ')}` }); continue; }
    shippable.push(c);
  }
  return { shippable, stripped };
}
```

```ts
// packages/core/src/index.ts  (append)
export { groundClaims } from './grounding.js';
```

- [ ] **Step 4: Run tests and commit**

Run: `pnpm --filter @sonny/core test` → Expected: PASS.

```bash
git add -A
git commit -m "feat(core): grounding gate — no token, no ship"
```

---

### Task 8: Decorrelated verifier

**Files:**
- Create: `packages/core/src/verifier.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/verifier.test.ts`

**Interfaces:**
- Consumes: `Claim`, `Verdict`, `VerdictSchema`, `EvidenceStore`, `StructuredModel`, `MODEL_ROUTER`.
- Produces: `function verifyClaims(claims: Claim[], store: EvidenceStore, model: StructuredModel, modelId?: string): Promise<Verdict[]>`. One verifier call per claim; the prompt includes the claim text and the full text of each cited evidence record.

- [ ] **Step 1: Write the failing test (fake model returns canned verdicts)**

```ts
// packages/core/src/verifier.test.ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { Claim, Evidence } from '@sonny/shared';
import { EvidenceStore } from './evidenceStore.js';
import { verifyClaims } from './verifier.js';
import type { StructuredModel } from './model.js';

const ev = (id: string, snippet: string): Evidence => ({ id, kind: 'publication', source: 'PubMed', title: 't', snippet, url: 'u', raw: {}, retrievedAt: 'now' });
const claim = (id: string, text: string): Claim => ({ id, text, citations: ['PMID:1'], confidence: 0.9 });

const fakeModel: StructuredModel = {
  async generateStructured({ prompt, schema }) {
    const status = prompt.includes('cures everything') ? 'overreach' : 'supported';
    return schema.parse({ claimId: 'will-be-overwritten', status, rationale: 'r' }) as z.infer<typeof schema>;
  },
};

describe('verifyClaims', () => {
  it('produces one verdict per claim, keyed to the claim id', async () => {
    const s = new EvidenceStore(); s.register(ev('PMID:1', 'evidence text'));
    const verdicts = await verifyClaims([claim('c1', 'normal claim'), claim('c2', 'drug cures everything')], s, fakeModel);
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]).toMatchObject({ claimId: 'c1', status: 'supported' });
    expect(verdicts[1]).toMatchObject({ claimId: 'c2', status: 'overreach' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/core test`
Expected: FAIL — `Cannot find module './verifier.js'`.

- [ ] **Step 3: Implement the verifier**

```ts
// packages/core/src/verifier.ts
import { VerdictSchema, type Claim, type Verdict } from '@sonny/shared';
import type { EvidenceStore } from './evidenceStore.js';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';

const SYSTEM = `You are an adversarial scientific reviewer. Decide whether the cited evidence SUPPORTS the claim.
- "supported": the evidence directly backs the claim.
- "unsupported": the evidence does not back the claim.
- "overreach": the claim asserts more than the evidence shows (e.g. "all patients", "cures").
Judge ONLY from the provided evidence. Be strict.`;

export async function verifyClaims(
  claims: Claim[],
  store: EvidenceStore,
  model: StructuredModel,
  modelId: string = MODEL_ROUTER.verifier,
): Promise<Verdict[]> {
  const verdicts: Verdict[] = [];
  for (const c of claims) {
    const evidenceText = c.citations
      .map((id) => store.get(id))
      .filter((e): e is NonNullable<typeof e> => Boolean(e))
      .map((e) => `[${e.id}] ${e.title} — ${e.snippet}`)
      .join('\n');
    const prompt = `CLAIM:\n${c.text}\n\nEVIDENCE:\n${evidenceText}`;
    const raw = await model.generateStructured({ system: SYSTEM, prompt, schema: VerdictSchema, model: modelId });
    verdicts.push({ ...raw, claimId: c.id });
  }
  return verdicts;
}
```

```ts
// packages/core/src/index.ts  (append)
export { verifyClaims } from './verifier.js';
```

- [ ] **Step 4: Run tests and commit**

Run: `pnpm --filter @sonny/core test` → Expected: PASS.

```bash
git add -A
git commit -m "feat(core): decorrelated verifier (one call per claim, claim-keyed)"
```

---

### Task 9: Orchestrator (the full slice loop)

**Files:**
- Create: `packages/core/src/orchestrator.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/package.json` (add `@sonny/mcp-gateway`)
- Test: `packages/core/src/orchestrator.test.ts`

**Interfaces:**
- Consumes: `Tool` (`@sonny/mcp-gateway`), `EvidenceStore`, `groundClaims`, `verifyClaims`, `StructuredModel`, `MODEL_ROUTER`, `ClaimsSchema`, `TraceEvent`.
- Produces: `async function runOrchestration(opts: { query: string; symbol: string; tools: Tool[]; specialistModel: StructuredModel; verifierModel: StructuredModel; emit: (e: TraceEvent) => void }): Promise<{ section: string; shipped: Claim[]; verdicts: Verdict[] }>`. Plans (emits plan event for the Target-Biology specialist) → runs each tool → registers evidence → specialist drafts claims → grounding gate → verification → synthesis of supported claims.

- [ ] **Step 1: Add gateway dependency**

Edit `packages/core/package.json` dependencies: add `"@sonny/mcp-gateway": "workspace:*"`. Run `pnpm install`.

- [ ] **Step 2: Write the failing test (fakes for tools + both models)**

```ts
// packages/core/src/orchestrator.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { Evidence, TraceEvent } from '@sonny/shared';
import type { Tool } from '@sonny/mcp-gateway';
import type { StructuredModel } from './model.js';
import { runOrchestration } from './orchestrator.js';

const ev: Evidence = { id: 'ENSG00000146648', kind: 'target', source: 'Open Targets', title: 'EGFR', snippet: 'RTK', url: 'u', raw: {}, retrievedAt: 'now' };
const targetTool: Tool = { name: 'open_targets_search', description: '', call: async () => [ev] };

const specialistModel: StructuredModel = {
  async generateStructured({ schema }) {
    return schema.parse({ claims: [
      { id: 'c1', text: 'EGFR is a receptor tyrosine kinase.', citations: ['ENSG00000146648'], confidence: 0.95 },
      { id: 'c2', text: 'EGFR is unrelated to cancer.', citations: [], confidence: 0.4 },
    ] });
  },
};
const verifierModel: StructuredModel = {
  async generateStructured({ schema }) { return schema.parse({ claimId: 'x', status: 'supported', rationale: 'r' }); },
};

describe('runOrchestration', () => {
  it('runs tools, grounds, verifies, and synthesizes only shipped claims', async () => {
    const events: TraceEvent[] = [];
    const out = await runOrchestration({
      query: 'Is EGFR oncogenic?', symbol: 'EGFR', tools: [targetTool],
      specialistModel, verifierModel, emit: (e) => events.push(e),
    });
    // c2 has no citation -> stripped; only c1 ships and is verified
    expect(out.shipped.map((c) => c.id)).toEqual(['c1']);
    expect(out.verdicts).toHaveLength(1);
    expect(out.section).toContain('receptor tyrosine kinase');
    expect(events.find((e) => e.type === 'plan')).toBeTruthy();
    expect(events.find((e) => e.type === 'evidence_registered')).toBeTruthy();
  });

  it('continues if one tool fails (allSettled)', async () => {
    const boom: Tool = { name: 'bad', description: '', call: async () => { throw new Error('429'); } };
    const events: TraceEvent[] = [];
    const out = await runOrchestration({
      query: 'q', symbol: 'EGFR', tools: [boom, targetTool],
      specialistModel, verifierModel, emit: (e) => events.push(e),
    });
    expect(out.shipped).toHaveLength(1);
    expect(events.find((e) => e.type === 'error')).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @sonny/core test`
Expected: FAIL — `Cannot find module './orchestrator.js'`.

- [ ] **Step 4: Implement the orchestrator**

```ts
// packages/core/src/orchestrator.ts
import { ClaimsSchema, type Claim, type TraceEvent, type Verdict } from '@sonny/shared';
import type { Tool } from '@sonny/mcp-gateway';
import { EvidenceStore } from './evidenceStore.js';
import { groundClaims } from './grounding.js';
import { verifyClaims } from './verifier.js';
import type { StructuredModel } from './model.js';

const SPECIALIST_SYSTEM = `You are a Target-Biology specialist. Using ONLY the provided evidence, write factual claims.
Every claim MUST cite the evidence id(s) it is based on (e.g. "ENSG00000146648", "PMID:123"). If the evidence does not
support a statement, do not make it. Return claims with ids c1, c2, ... and a confidence in [0,1].`;

function argsForTool(name: string, query: string, symbol: string): Record<string, unknown> {
  if (name === 'open_targets_search') return { symbol };
  if (name === 'pubmed_search') return { query: `${symbol} ${query}` };
  return { query };
}

export async function runOrchestration(opts: {
  query: string; symbol: string; tools: Tool[];
  specialistModel: StructuredModel; verifierModel: StructuredModel;
  emit: (e: TraceEvent) => void;
}): Promise<{ section: string; shipped: Claim[]; verdicts: Verdict[] }> {
  const { query, symbol, tools, specialistModel, verifierModel, emit } = opts;
  const store = new EvidenceStore();

  emit({ type: 'plan', specialists: ['target_biology'], tools: tools.map((t) => t.name) });

  // Fan out over tools; one failure must not discard the rest.
  const settled = await Promise.allSettled(tools.map(async (t) => {
    const args = argsForTool(t.name, query, symbol);
    emit({ type: 'tool_call', tool: t.name, args });
    const evidence = await t.call(args);
    emit({ type: 'tool_result', tool: t.name, count: evidence.length });
    return evidence;
  }));
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      for (const e of r.value) { store.register(e); emit({ type: 'evidence_registered', id: e.id, title: e.title }); }
    } else {
      emit({ type: 'error', message: `tool ${tools[i].name} failed: ${String(r.reason)}` });
    }
  });

  const evidenceList = store.all().map((e) => `[${e.id}] ${e.title} — ${e.snippet}`).join('\n');
  const drafted = await specialistModel.generateStructured({
    system: SPECIALIST_SYSTEM,
    prompt: `QUESTION:\n${query}\n\nEVIDENCE:\n${evidenceList}`,
    schema: ClaimsSchema, model: 'claude-opus-4-8',
  });
  for (const c of drafted.claims) emit({ type: 'claim_drafted', claim: c });

  const { shippable } = groundClaims(drafted.claims, store);
  const verdicts = await verifyClaims(shippable, store, verifierModel);
  for (const v of verdicts) emit({ type: 'verdict', verdict: v });

  const supported = shippable.filter((c) => verdicts.find((v) => v.claimId === c.id)?.status === 'supported');
  const section = supported.map((c) => `${c.text} ${c.citations.map((id) => `[${id}]`).join(' ')}`).join('\n');
  emit({ type: 'synthesis', section });

  return { section, shipped: supported, verdicts };
}
```

```ts
// packages/core/src/index.ts  (append)
export { runOrchestration } from './orchestrator.js';
```

- [ ] **Step 5: Run tests and commit**

Run: `pnpm --filter @sonny/core test` → Expected: PASS (both tests).

```bash
git add -A
git commit -m "feat(core): orchestrator — plan→tools→ground→verify→synthesize with allSettled fan-out"
```

---

### Task 10: CLI app (live wiring + smoke test)

**Files:**
- Create: `apps/cli/package.json`, `apps/cli/tsconfig.json`, `apps/cli/src/run.ts`, `apps/cli/src/index.ts`
- Test: `apps/cli/src/run.test.ts`

**Interfaces:**
- Consumes: `runOrchestration`, `AnthropicModel`, `MODEL_ROUTER` (`@sonny/core`); `openTargetsTool`, `pubmedTool` (`@sonny/mcp-gateway`).
- Produces: `function formatTrace(events: TraceEvent[]): string`; `async function main(argv: string[]): Promise<void>`. `index.ts` is the executable entry that reads the query from argv.

- [ ] **Step 1: Create manifests**

```json
// apps/cli/package.json
{
  "name": "@sonny/cli",
  "version": "0.0.0",
  "type": "module",
  "bin": { "sonny": "dist/index.js" },
  "scripts": { "test": "vitest run", "build": "tsc -p tsconfig.json", "start": "node --loader ts-node/esm src/index.ts" },
  "dependencies": { "@sonny/core": "workspace:*", "@sonny/mcp-gateway": "workspace:*", "@sonny/shared": "workspace:*" }
}
```

```json
// apps/cli/tsconfig.json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
```

- [ ] **Step 2: Write the failing test (pure formatter — no network)**

```ts
// apps/cli/src/run.test.ts
import { describe, it, expect } from 'vitest';
import type { TraceEvent } from '@sonny/shared';
import { formatTrace } from './run.js';

describe('formatTrace', () => {
  it('renders plan, evidence, and verdict lines', () => {
    const events: TraceEvent[] = [
      { type: 'plan', specialists: ['target_biology'], tools: ['open_targets_search'] },
      { type: 'evidence_registered', id: 'ENSG00000146648', title: 'EGFR' },
      { type: 'verdict', verdict: { claimId: 'c1', status: 'supported', rationale: 'r' } },
    ];
    const out = formatTrace(events);
    expect(out).toContain('PLAN');
    expect(out).toContain('ENSG00000146648');
    expect(out).toContain('supported');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @sonny/cli test`
Expected: FAIL — `Cannot find module './run.js'`.

- [ ] **Step 4: Implement the CLI**

```ts
// apps/cli/src/run.ts
import type { TraceEvent } from '@sonny/shared';
import { runOrchestration, AnthropicModel, MODEL_ROUTER } from '@sonny/core';
import { openTargetsTool, pubmedTool } from '@sonny/mcp-gateway';

export function formatTrace(events: TraceEvent[]): string {
  return events.map((e) => {
    switch (e.type) {
      case 'plan': return `PLAN  specialists=${e.specialists.join(',')} tools=${e.tools.join(',')}`;
      case 'tool_call': return `  → ${e.tool}(${JSON.stringify(e.args)})`;
      case 'tool_result': return `  ← ${e.tool}: ${e.count} record(s)`;
      case 'evidence_registered': return `  • ${e.id}  ${e.title}`;
      case 'claim_drafted': return `  claim ${e.claim.id}: ${e.claim.text}`;
      case 'verdict': return `  verdict ${e.verdict.claimId}: ${e.verdict.status}`;
      case 'synthesis': return `\nSYNTHESIS:\n${e.section}`;
      case 'error': return `  ! ${e.message}`;
    }
  }).join('\n');
}

export async function main(argv: string[]): Promise<void> {
  const query = argv.slice(2).join(' ').trim() || 'Is EGFR a druggable target in NSCLC?';
  const symbol = (query.match(/\b[A-Z0-9]{2,7}\b/)?.[0]) ?? 'EGFR';
  const specialistModel = new AnthropicModel();
  const verifierModel = new AnthropicModel();
  const events: TraceEvent[] = [];
  await runOrchestration({
    query, symbol, tools: [openTargetsTool, pubmedTool],
    specialistModel, verifierModel,
    emit: (e) => { events.push(e); process.stdout.write(formatTrace([e]) + '\n'); },
  });
  void MODEL_ROUTER;
}
```

```ts
// apps/cli/src/index.ts
import { main } from './run.js';
main(process.argv).catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 5: Run unit test, then verify the live run manually**

Run: `pnpm --filter @sonny/cli test` → Expected: PASS (formatter test).

Manual (requires key): `ANTHROPIC_API_KEY=sk-... pnpm --filter @sonny/cli start "Is EGFR a druggable target in NSCLC?"`
Expected: a printed trace (PLAN → tool calls → evidence with real ENSG/PMID ids → verdicts → SYNTHESIS) where every synthesized sentence carries a real `[ENSG…]`/`[PMID:…]` id.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(cli): wire end-to-end grounded slice with trace output"
```

---

### Task 11: Eval harness (faithfulness + recall@k)

**Files:**
- Create: `eval/package.json`, `eval/tsconfig.json`, `eval/golden/egfr.json`, `eval/src/score.ts`, `eval/src/index.ts`
- Test: `eval/src/score.test.ts`

**Interfaces:**
- Consumes: `Claim`, `Verdict`, `Evidence`.
- Produces: `function recallAtK(retrievedIds: string[], expectedIds: string[]): number`; `function faithfulness(shipped: Claim[], verdicts: Verdict[]): number`. (Pure functions; CI-runnable without network.)

- [ ] **Step 1: Create manifests + golden fixture**

```json
// eval/package.json
{ "name": "@sonny/eval", "version": "0.0.0", "type": "module",
  "scripts": { "test": "vitest run", "build": "tsc -p tsconfig.json" },
  "dependencies": { "@sonny/shared": "workspace:*" } }
```

```json
// eval/tsconfig.json
{ "extends": "../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
```

```json
// eval/golden/egfr.json
{ "query": "Is EGFR oncogenic in NSCLC?", "symbol": "EGFR", "expectedEvidenceIds": ["ENSG00000146648"] }
```

- [ ] **Step 2: Write the failing test**

```ts
// eval/src/score.test.ts
import { describe, it, expect } from 'vitest';
import type { Claim, Verdict } from '@sonny/shared';
import { recallAtK, faithfulness } from './score.js';

describe('eval metrics', () => {
  it('recallAtK = fraction of expected ids retrieved', () => {
    expect(recallAtK(['ENSG00000146648', 'PMID:1'], ['ENSG00000146648'])).toBe(1);
    expect(recallAtK(['PMID:1'], ['ENSG00000146648'])).toBe(0);
  });
  it('faithfulness = fraction of shipped claims verified supported', () => {
    const shipped: Claim[] = [{ id: 'c1', text: 'x', citations: ['PMID:1'], confidence: 1 }, { id: 'c2', text: 'y', citations: ['PMID:2'], confidence: 1 }];
    const verdicts: Verdict[] = [{ claimId: 'c1', status: 'supported', rationale: '' }, { claimId: 'c2', status: 'overreach', rationale: '' }];
    expect(faithfulness(shipped, verdicts)).toBe(0.5);
  });
  it('faithfulness is 1 when there are no shipped claims (vacuous)', () => {
    expect(faithfulness([], [])).toBe(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @sonny/eval test`
Expected: FAIL — `Cannot find module './score.js'`.

- [ ] **Step 4: Implement the metrics + a runner**

```ts
// eval/src/score.ts
import type { Claim, Verdict } from '@sonny/shared';

export function recallAtK(retrievedIds: string[], expectedIds: string[]): number {
  if (expectedIds.length === 0) return 1;
  const found = expectedIds.filter((id) => retrievedIds.includes(id)).length;
  return found / expectedIds.length;
}

export function faithfulness(shipped: Claim[], verdicts: Verdict[]): number {
  if (shipped.length === 0) return 1;
  const supported = shipped.filter((c) => verdicts.find((v) => v.claimId === c.id)?.status === 'supported').length;
  return supported / shipped.length;
}
```

```ts
// eval/src/index.ts
// Live eval runner (opt-in): runs the orchestrator on each golden case and prints metrics.
// Usage: ANTHROPIC_API_KEY=... pnpm --filter @sonny/eval exec node --loader ts-node/esm src/index.ts
import { readFileSync } from 'node:fs';
import { runOrchestration, AnthropicModel } from '@sonny/core';
import { openTargetsTool, pubmedTool } from '@sonny/mcp-gateway';
import type { Evidence, TraceEvent } from '@sonny/shared';
import { recallAtK, faithfulness } from './score.js';

const gold = JSON.parse(readFileSync(new URL('../golden/egfr.json', import.meta.url), 'utf8')) as
  { query: string; symbol: string; expectedEvidenceIds: string[] };

const retrieved: string[] = [];
const out = await runOrchestration({
  query: gold.query, symbol: gold.symbol, tools: [openTargetsTool, pubmedTool],
  specialistModel: new AnthropicModel(), verifierModel: new AnthropicModel(),
  emit: (e: TraceEvent) => { if (e.type === 'evidence_registered') retrieved.push(e.id); },
});
console.log('recall@k :', recallAtK(retrieved, gold.expectedEvidenceIds));
console.log('faithfulness :', faithfulness(out.shipped, out.verdicts));
void ({} as Evidence);
```

Note: `eval/package.json` also needs `"@sonny/core"` and `"@sonny/mcp-gateway"` as `workspace:*` dependencies for the runner; add them and run `pnpm install`.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm --filter @sonny/eval test` → Expected: PASS (3 tests).

```bash
git add -A
git commit -m "feat(eval): recall@k + faithfulness metrics with golden runner"
```

---

## Self-Review

**Spec coverage (Plan 1 scope = §1 Phase-1 trust-core slice):**
- §3 evidence store → Task 3 ✓ · grounding "no token no ship" → Task 7 ✓ · decorrelated verifier → Task 8 ✓ · orchestrator + TraceEvents → Task 9 ✓ · structured-output contract → Tasks 2,4 ✓
- §4 API-grounding via gateway tools + canonical-ID normalization → Tasks 5,6 ✓ · ModelRouter → Task 4 ✓ · `allSettled` robustness → Task 9 ✓
- §8 faithfulness + recall@k eval → Task 11 ✓
- Global constraints (BYO key, verifier≠synthesizer, no-regex structured output) → enforced in Tasks 4,8,9 ✓
- **Deferred to later plans (intentionally, per scope check):** web glass-box (Plan 2), graph (Plan 3), more specialists/dynamic selection (Plan 4), `combination-drug-screening` (Plan 5), financials (Plan 6), Slack + prod hardening (Plan 7). These are NOT gaps in Plan 1.

**Placeholder scan:** none — every code/test step contains complete code and exact commands.

**Type consistency:** `Evidence`/`Claim`/`Verdict`/`TraceEvent` defined in Task 2 are used verbatim everywhere; `StructuredModel.generateStructured` signature is identical across Tasks 4/8/9/10; `Tool.call(args, fetchImpl?)` identical across Tasks 5/6/9; `runOrchestration` return shape (`{section, shipped, verdicts}`) consumed consistently by Tasks 10/11; `groundClaims`/`verifyClaims`/`recallAtK`/`faithfulness` names match their call sites.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-27-sonny-v2-core-slice.md`.
