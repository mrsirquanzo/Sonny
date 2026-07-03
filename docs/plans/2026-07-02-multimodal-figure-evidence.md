# Multimodal Figure Evidence (Slice 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Sonny retrieve a deep-read paper's figures, register each figure's caption as grounded `Evidence`, read the figures with a decorrelated vision model behind a stubbed sidecar, and prove the lift with an eval metric - all in TypeScript, with the GPU service deferred to Slice 4b.

**Architecture:** `pmc_figures` is a standard `Tool` that fetches PMC figures and registers one `Evidence` per figure whose `passage` is the author caption (the grounding anchor). `figure_read` is a standalone `readFigures()` function (not a `Tool`, because it returns `FigureReading[]` not `Evidence[]`) that POSTs to a Python sidecar for ranking + VLM reads, then computes `inCaption` and the binary `readRisk` deterministically in TypeScript. A thin `researchFigures()` step wires both into `researcher.ts` after the skeptic audit, gated by `SONNY_FIGURES`. The figure-caption Evidence flows into claim extraction for free via the existing store; the VLM readings are surfaced on a new `figure_read` trace event and scored by a new `figure_grounding` eval metric.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Zod, `fast-xml-parser`, Vitest, pnpm workspaces. Packages: `@mrsirquanzo/sonny-shared`, `@mrsirquanzo/sonny-mcp-gateway`, `@mrsirquanzo/sonny-core`, `@sonny/eval`.

## Global Constraints

- **Branch:** all work lands on `hardening/slice-4-figures` (namespaced per the spec's canonical-numbering rule). Create it before Task 1 if not already on it.
- **TDD, always:** failing Vitest first, minimal implementation, passing test, commit. One logical change per commit.
- **ESM import specifiers end in `.js`** even for `.ts` files (repo convention, see any existing file).
- **`readRisk` is binary `"low" | "high"`.** No `moderate` tier in this slice.
- **`inCaption`/`readRisk` are computed in TypeScript, never returned by the sidecar.** The sidecar wire response carries neither.
- **A false `high` is the safe direction.** Numeric normalization may start simple; it must never launder a pixel-only value to `low`.
- **Grounding ids are set in code, never by the model.** `FigureReading.evidenceId` must be one of the figure ids we sent; drop any reading whose `figureId` we did not send.
- **Env flags:** `SONNY_FIGURES` (default on; `=off` disables both figure Tools) and `SONNY_FIGURES_SIDECAR` (sidecar base URL, default `http://localhost:8077`).
- **Tool naming:** the Tool is named `pmc_figures`; the function is `readFigures`.
- **Slice 1 dependency:** Task 0 and Task 6 require the Slice 1 eval harness (`eval` with `goldenSet.ts`, `metrics.ts`, `scorecard.ts`, `runner.ts`) to be landed. Tasks 1-5 do not. If Slice 1 is not yet merged, implement Tasks 1-5 and hold 0/6.
- **Per-package test command:** `pnpm --filter @mrsirquanzo/sonny-<pkg> exec vitest run <path>` (e.g. `@mrsirquanzo/sonny-mcp-gateway`). Full suite: `pnpm -r test`.

---

## Task 0: Source and confirm the figure-heavy golden target (Slice 1 dependent, operational)

This is an operational task, not a code change: it produces the confirmed target Task 6 needs. Its acceptance is a run, not a bibliographic check.

**Files:**
- Produce (held for Task 6): the concrete `{ target, seminalPmid, figure HR value, claimProbe }` for one figure-heavy target.

**Interfaces:**
- Produces: the values Task 6's golden JSON consumes (target symbol, seminal PMID/PMCID, the figure-borne HR string, and the probe statement whose answer is that HR).

- [ ] **Step 1: Find a candidate.** Search PMC Open Access for an open-access meta-analysis or subgroup forest plot where an exact hazard ratio and 95% CI are rendered in the plot (or its caption) and are NOT enumerated in the body prose that `pmc_fulltext` ingests. Subgroup and per-study forest-plot estimates are the richest vein. Record the PMCID, the figure number, and the exact HR + CI string.

- [ ] **Step 2: Confirm the baseline miss.** With Slice 1 landed, run `SONNY_FIGURES=off pnpm --filter @sonny/eval exec tsx src/runner.ts --subset fast` against a one-off golden file containing only a `claimProbe` whose answer is that HR. Confirm the probe is NOT satisfied (the value never enters the dossier text-only). If it IS satisfied text-only, the HR is in the body prose too; discard and return to Step 1.

- [ ] **Step 3: Record the confirmed target.** Write down the target symbol, PMCID, HR string, and the exact `claimProbe.statement`. These are Task 6's inputs. Do not create the golden JSON yet (Task 6 does, after the figures-on path exists to satisfy it).

*No commit (no repo change). This task's output is the confirmed target record.*

---

## Task 1: Contracts - `figure` kind, `FigureReading`, wire schemas, trace event

**Files:**
- Modify: `packages/shared/src/contracts.ts`
- Test: `packages/shared/src/contracts.test.ts`

**Interfaces:**
- Produces:
  - `EvidenceKind` gains `'figure'`.
  - `EvidenceMetadata` gains optional `figureType?: string`, `imageRef?: string`.
  - `ExtractedValueWireSchema`, `FigureReadingWireSchema`, `FiguresAnalyzeResponseSchema` (the sidecar wire shape; no `inCaption`/`readRisk`).
  - `FigureTypeSchema`, `ExtractedValueSchema` (`{ label, value, unit?, inCaption: boolean, readRisk: 'low'|'high' }`), `FigureReadingSchema`, type `FigureReading`.
  - `TraceEvent` gains `{ type: 'figure_read'; specialist: string; readings: FigureReading[] }`.

- [ ] **Step 1: Write the failing test**

Add to `packages/shared/src/contracts.test.ts`:

```typescript
import {
  EvidenceKindSchema, FigureReadingSchema, FiguresAnalyzeResponseSchema,
} from './contracts.js';

describe('figure contracts', () => {
  it("accepts 'figure' as an Evidence kind", () => {
    expect(EvidenceKindSchema.parse('figure')).toBe('figure');
  });

  it('validates a FigureReading with binary readRisk', () => {
    const r = FigureReadingSchema.parse({
      evidenceId: 'PMCID:PMC1#fig-0',
      figureType: 'forest_plot',
      reading: 'Pooled HR 0.62.',
      extractedValues: [{ label: 'HR', value: '0.62', inCaption: true, readRisk: 'low' }],
      confidence: 0.8,
    });
    expect(r.extractedValues[0].readRisk).toBe('low');
  });

  it('rejects readRisk="moderate" (no moderate tier this slice)', () => {
    expect(() => FigureReadingSchema.parse({
      evidenceId: 'x', reading: 'r', confidence: 0.5,
      extractedValues: [{ label: 'HR', value: '1', inCaption: false, readRisk: 'moderate' }],
    })).toThrow();
  });

  it('parses a sidecar wire response that omits inCaption/readRisk', () => {
    const w = FiguresAnalyzeResponseSchema.parse({
      readings: [{
        figureId: 'PMCID:PMC1#fig-0', relevanceScore: 0.9, figureType: 'bar',
        reading: 'r', extractedValues: [{ label: 'x', value: '1' }], confidence: 0.7,
      }],
    });
    expect(w.readings[0].extractedValues[0]).not.toHaveProperty('readRisk');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mrsirquanzo/sonny-shared exec vitest run src/contracts.test.ts`
Expected: FAIL (`FigureReadingSchema`/`FiguresAnalyzeResponseSchema` not exported; `'figure'` not in enum).

- [ ] **Step 3: Add `'figure'` to the kind enum and extend metadata**

In `packages/shared/src/contracts.ts`, change line 3:

```typescript
export const EvidenceKindSchema = z.enum(['target', 'publication', 'trial', 'patent', 'dataset', 'disease', 'drug', 'figure']);
```

And extend `EvidenceMetadataSchema` (the object at lines 13-16):

```typescript
export const EvidenceMetadataSchema = z.object({
  authors: z.array(AuthorSchema).optional(),
  institutions: z.array(z.string()).optional(),
  figureType: z.string().optional(),
  imageRef: z.string().optional(),
});
```

- [ ] **Step 4: Add the figure schemas immediately before the `TraceEvent` union**

Insert into `packages/shared/src/contracts.ts` just above `export type TraceEvent =` (currently line 114):

```typescript
// --- Figure evidence (Slice 4) ---

// The sidecar WIRE response. Carries NO inCaption and NO readRisk; those are
// derived in TypeScript by readFigures (see mcp-gateway/figureRead.ts).
export const ExtractedValueWireSchema = z.object({
  label: z.string(),
  value: z.string(),
  unit: z.string().optional(),
});
export const FigureReadingWireSchema = z.object({
  figureId: z.string().min(1),
  relevanceScore: z.number(),
  figureType: z.string().optional(),
  reading: z.string(),
  extractedValues: z.array(ExtractedValueWireSchema),
  confidence: z.number().min(0).max(1),
});
export const FiguresAnalyzeResponseSchema = z.object({
  readings: z.array(FigureReadingWireSchema),
});
export type FiguresAnalyzeResponse = z.infer<typeof FiguresAnalyzeResponseSchema>;

export const FigureTypeSchema = z.enum([
  'forest_plot', 'kaplan_meier', 'dose_response', 'bar', 'flow', 'other',
]);
export type FigureType = z.infer<typeof FigureTypeSchema>;

// The Tool's OUTPUT. inCaption is a deterministic TS fact; readRisk is binary.
export const ExtractedValueSchema = z.object({
  label: z.string(),
  value: z.string(),
  unit: z.string().optional(),
  inCaption: z.boolean(),
  readRisk: z.enum(['low', 'high']),
});
export type ExtractedValue = z.infer<typeof ExtractedValueSchema>;

export const FigureReadingSchema = z.object({
  evidenceId: z.string().min(1),
  figureType: FigureTypeSchema.optional(),
  reading: z.string(),
  extractedValues: z.array(ExtractedValueSchema),
  confidence: z.number().min(0).max(1),
});
export type FigureReading = z.infer<typeof FigureReadingSchema>;
```

- [ ] **Step 5: Add the trace event variant**

In the `TraceEvent` union, add one line (e.g. after the `methodological_critique` variant):

```typescript
  | { type: 'figure_read'; specialist: string; readings: FigureReading[] }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @mrsirquanzo/sonny-shared exec vitest run src/contracts.test.ts`
Expected: PASS.

- [ ] **Step 7: Type-check the package**

Run: `pnpm --filter @mrsirquanzo/sonny-shared exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/contracts.ts packages/shared/src/contracts.test.ts
git commit -m "feat(shared): figure evidence contracts (kind, FigureReading, wire schemas, trace event)"
```

---

## Task 2: `pmc_figures` Tool - fetch and register figures as caption-anchored Evidence

**Files:**
- Create: `packages/mcp-gateway/src/pmcFigures.ts`
- Test: `packages/mcp-gateway/src/pmcFigures.test.ts`
- Modify: `packages/mcp-gateway/src/index.ts`

**Interfaces:**
- Consumes: `Tool` (from `./tool.js`), `Evidence` (from `@mrsirquanzo/sonny-shared`).
- Produces: `pmcFiguresTool: Tool` (name `'pmc_figures'`). One `Evidence` per figure: `kind: 'figure'`, `passage` = author caption, `url` = figure image URL, `locator`/id `#fig-<i>`, `metadata.imageRef`.

- [ ] **Step 1: Write the failing test**

Create `packages/mcp-gateway/src/pmcFigures.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { pmcFiguresTool } from './pmcFigures.js';

const xml = `<?xml version="1.0"?><pmc-articleset><article><body>
  <sec><title>Results</title><p>Efficacy was observed.</p>
    <fig id="F2"><label>Figure 2</label>
      <caption><p>Forest plot of overall survival. Pooled HR 0.62 (95% CI 0.48-0.79).</p></caption>
      <graphic xlink:href="pone.0000002.g002"/>
    </fig>
  </sec>
</body></article></pmc-articleset>`;

const okFetch = (async () => new Response(xml, { status: 200 })) as unknown as typeof fetch;

describe('pmcFiguresTool', () => {
  it('parses figures into caption-anchored Evidence', async () => {
    const out = await pmcFiguresTool.call({ pmcid: 'PMC7897327' }, okFetch);
    expect(out).toHaveLength(1);
    const f = out[0];
    expect(f.id).toBe('PMCID:PMC7897327#fig-0');
    expect(f.kind).toBe('figure');
    expect(f.title).toBe('Figure 2');
    expect(f.passage).toContain('Pooled HR 0.62');
    expect(f.locator).toBe('fig-0');
    expect(f.url).toContain('/PMC7897327/bin/pone.0000002.g002');
    expect(f.metadata?.imageRef).toBe('pone.0000002.g002');
  });

  it('returns [] for a missing pmcid', async () => {
    expect(await pmcFiguresTool.call({}, okFetch)).toEqual([]);
  });

  it('throws on non-OK HTTP so safeToolCall can isolate it', async () => {
    const bad = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    await expect(pmcFiguresTool.call({ pmcid: 'PMC1' }, bad)).rejects.toThrow(/HTTP 500/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mrsirquanzo/sonny-mcp-gateway exec vitest run src/pmcFigures.test.ts`
Expected: FAIL (`pmcFigures.js` does not exist).

- [ ] **Step 3: Write the implementation**

Create `packages/mcp-gateway/src/pmcFigures.ts`:

```typescript
import { XMLParser } from 'fast-xml-parser';
import type { Evidence } from '@mrsirquanzo/sonny-shared';
import type { Tool } from './tool.js';

const EFETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';
// Attributes ON so we can read graphic xlink:href (the figure image ref).
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' });

function textOf(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'object') {
    // Skip attribute keys (prefixed @_) when flattening to text.
    return Object.entries(node as Record<string, unknown>)
      .filter(([k]) => !k.startsWith('@_'))
      .map(([, v]) => textOf(v)).join(' ');
  }
  return '';
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

function collectFigs(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (node == null || typeof node !== 'object') return out;
  const n = node as Record<string, unknown>;
  for (const fig of asArray(n.fig as unknown)) out.push(fig as Record<string, unknown>);
  for (const [k, v] of Object.entries(n)) {
    if (k === 'fig' || k.startsWith('@_')) continue;
    if (Array.isArray(v)) v.forEach((c) => collectFigs(c, out));
    else if (typeof v === 'object') collectFigs(v, out);
  }
  return out;
}

function graphicHref(fig: Record<string, unknown>): string | undefined {
  const g = fig.graphic as Record<string, unknown> | Record<string, unknown>[] | undefined;
  const first = Array.isArray(g) ? g[0] : g;
  const href = first?.['@_xlink:href'] ?? first?.['@_href'];
  return href == null ? undefined : String(href);
}

export const pmcFiguresTool: Tool = {
  name: 'pmc_figures',
  description: 'Fetch an open-access PMC article\'s figures (by PMC id) and register each as caption-anchored Evidence (kind: figure).',
  async call(args, fetchImpl = fetch) {
    const pmcid = String(args.pmcid ?? '').trim();
    if (!pmcid) return [];
    const numeric = pmcid.replace(/^PMC/i, '');
    const res = await fetchImpl(`${EFETCH}?db=pmc&id=${encodeURIComponent(numeric)}&rettype=full&retmode=xml`);
    if (!res.ok) throw new Error(`PMC efetch HTTP ${res.status}`);
    const doc = parser.parse(await res.text()) as Record<string, unknown>;
    const set = (doc['pmc-articleset'] ?? doc) as Record<string, unknown>;
    const articleRaw = set.article ?? set;
    const article = (Array.isArray(articleRaw) ? articleRaw[0] : articleRaw) as Record<string, unknown>;
    const figs = collectFigs(article.body ?? article);
    const now = new Date().toISOString();
    const out: Evidence[] = [];
    figs.forEach((fig, i) => {
      const caption = textOf(fig.caption).replace(/\s+/g, ' ').trim();
      if (!caption) return; // no caption = no grounding anchor, skip
      const label = textOf(fig.label).trim() || `Figure ${i + 1}`;
      const href = graphicHref(fig);
      out.push({
        id: `PMCID:${pmcid}#fig-${i}`, kind: 'figure', source: 'pmc',
        title: label, snippet: caption.slice(0, 200), passage: caption, locator: `fig-${i}`,
        url: href
          ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/bin/${href}`
          : `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/`,
        raw: fig, retrievedAt: now,
        metadata: href ? { imageRef: href } : undefined,
      });
    });
    return out;
  },
};
```

- [ ] **Step 4: Export it**

Add to `packages/mcp-gateway/src/index.ts`:

```typescript
export { pmcFiguresTool } from './pmcFigures.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @mrsirquanzo/sonny-mcp-gateway exec vitest run src/pmcFigures.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-gateway/src/pmcFigures.ts packages/mcp-gateway/src/pmcFigures.test.ts packages/mcp-gateway/src/index.ts
git commit -m "feat(mcp-gateway): pmc_figures Tool - register PMC figures as caption-anchored evidence"
```

---

## Task 3: The shared contract fixture (sidecar wire shape)

**Files:**
- Create: `packages/mcp-gateway/src/fixtures/figures-analyze.fixture.json`

**Interfaces:**
- Produces: the canonical `/figures/analyze` wire response used by Task 4's tests and (in Slice 4b) the Python Pydantic round-trip test. Encodes the wire shape only: no `inCaption`, no `readRisk`. Contains one value that will resolve `low` (present in the caption Task 4's test supplies) and one that will resolve `high` (absent).

- [ ] **Step 1: Create the fixture**

Create `packages/mcp-gateway/src/fixtures/figures-analyze.fixture.json`:

```json
{
  "readings": [
    {
      "figureId": "PMCID:PMC7897327#fig-0",
      "relevanceScore": 0.91,
      "figureType": "forest_plot",
      "reading": "Figure 2 is a forest plot of overall survival; the pooled hazard ratio is 0.62 (95% CI 0.48-0.79), favoring treatment. A PD-L1-high subgroup shows HR 0.41.",
      "extractedValues": [
        { "label": "pooled HR", "value": "0.62" },
        { "label": "PD-L1-high subgroup HR", "value": "0.41" }
      ],
      "confidence": 0.78
    }
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/mcp-gateway/src/fixtures/figures-analyze.fixture.json
git commit -m "test(mcp-gateway): add shared figures-analyze wire-shape fixture (contract of record)"
```

---

## Task 4: `readFigures` - sidecar client + deterministic `inCaption`/`readRisk`

**Files:**
- Create: `packages/mcp-gateway/src/figureRead.ts`
- Test: `packages/mcp-gateway/src/figureRead.test.ts`
- Modify: `packages/mcp-gateway/src/index.ts`

**Interfaces:**
- Consumes: `FiguresAnalyzeResponseSchema`, `FigureTypeSchema`, types `FigureReading`, `FigureType` (from `@mrsirquanzo/sonny-shared`); the Task 3 fixture.
- Produces:
  - `normalizeNumeric(s: string): string`
  - `captionContainsValue(caption: string, value: string): boolean`
  - `interface FigureInput { figureId: string; imageUrl: string; caption: string }`
  - `interface ReadFiguresOpts { question: string; figures: FigureInput[]; topK?: number; endpoint?: string; fetchImpl?: typeof fetch }`
  - `readFigures(opts: ReadFiguresOpts): Promise<FigureReading[]>` - POSTs to `${endpoint}/figures/analyze`, throws on non-OK, derives `inCaption`/`readRisk` in TS, drops readings whose `figureId` was not sent.

- [ ] **Step 1: Write the failing test**

Create `packages/mcp-gateway/src/figureRead.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFigures, normalizeNumeric, captionContainsValue } from './figureRead.js';
import fixture from './fixtures/figures-analyze.fixture.json' assert { type: 'json' };

const captionWith062 = 'Forest plot of overall survival. Pooled HR 0.620 (95% CI 0.48-0.79).';

const figures = [{
  figureId: 'PMCID:PMC7897327#fig-0',
  imageUrl: 'https://example/bin/g002',
  caption: captionWith062, // contains 0.620 (matches 0.62), does NOT contain 0.41
}];

const fixtureFetch = (async () => new Response(JSON.stringify(fixture), { status: 200 })) as unknown as typeof fetch;

describe('normalizeNumeric', () => {
  it('drops trailing zeros so 0.620 matches 0.62', () => {
    expect(normalizeNumeric('0.620')).toBe(normalizeNumeric('0.62'));
  });
  it('normalizes middle-dot and thousands separators', () => {
    expect(captionContainsValue('value 1,234 seen', '1234')).toBe(true);
    expect(captionContainsValue('ratio 0·62 shown', '0.62')).toBe(true);
  });
});

describe('readFigures', () => {
  it('derives readRisk: low for a caption-anchored value, high for a pixel-only value', async () => {
    const out = await readFigures({ question: 'survival benefit?', figures, fetchImpl: fixtureFetch });
    expect(out).toHaveLength(1);
    const vals = out[0].extractedValues;
    const hr = vals.find((v) => v.value === '0.62')!;
    const sub = vals.find((v) => v.value === '0.41')!;
    expect(hr.inCaption).toBe(true);
    expect(hr.readRisk).toBe('low');
    expect(sub.inCaption).toBe(false);
    expect(sub.readRisk).toBe('high');
    expect(out[0].evidenceId).toBe('PMCID:PMC7897327#fig-0');
  });

  it('throws on non-OK HTTP', async () => {
    const bad = (async () => new Response('x', { status: 502 })) as unknown as typeof fetch;
    await expect(readFigures({ question: 'q', figures, fetchImpl: bad })).rejects.toThrow(/HTTP 502/);
  });

  it('drops a reading whose figureId was not sent (grounding: ids set in code)', async () => {
    const rogue = { readings: [{ figureId: 'PMCID:PMCX#fig-9', relevanceScore: 1, reading: 'r', extractedValues: [], confidence: 0.5 }] };
    const rogueFetch = (async () => new Response(JSON.stringify(rogue), { status: 200 })) as unknown as typeof fetch;
    const out = await readFigures({ question: 'q', figures, fetchImpl: rogueFetch });
    expect(out).toEqual([]);
  });

  it('returns [] with no network call for empty figures', async () => {
    let called = false;
    const spyFetch = (async () => { called = true; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    expect(await readFigures({ question: 'q', figures: [], fetchImpl: spyFetch })).toEqual([]);
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mrsirquanzo/sonny-mcp-gateway exec vitest run src/figureRead.test.ts`
Expected: FAIL (`figureRead.js` does not exist).

- [ ] **Step 3: Write the implementation**

Create `packages/mcp-gateway/src/figureRead.ts`:

```typescript
import {
  FiguresAnalyzeResponseSchema, FigureTypeSchema,
  type FigureReading, type FigureType,
} from '@mrsirquanzo/sonny-shared';

// Normalize a numeric-bearing string so 0.620 == 0.62, 1,234 == 1234, 0·62 == 0.62.
// A false "high" (missed match) is the safe direction; never launder high -> low.
export function normalizeNumeric(s: string): string {
  return s
    .toLowerCase()
    .replace(/·/g, '.')                 // middle dot -> decimal point
    .replace(/(\d),(?=\d{3}(\D|$))/g, '$1')  // thousands separators: 1,234 -> 1234
    .replace(/(\d+\.\d*?)0+(?=\D|$)/g, '$1') // strip trailing zeros: 0.620 -> 0.62
    .replace(/(\d+)\.(?=\D|$)/g, '$1');      // strip bare trailing dot: 5. -> 5
}

export function captionContainsValue(caption: string, value: string): boolean {
  const v = normalizeNumeric(value.trim());
  if (!v) return false;
  return normalizeNumeric(caption).includes(v);
}

export interface FigureInput { figureId: string; imageUrl: string; caption: string }

export interface ReadFiguresOpts {
  question: string;
  figures: FigureInput[];
  topK?: number;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

export async function readFigures(opts: ReadFiguresOpts): Promise<FigureReading[]> {
  const { question, figures } = opts;
  if (figures.length === 0) return [];
  const topK = opts.topK ?? 3;
  const endpoint = opts.endpoint ?? process.env.SONNY_FIGURES_SIDECAR ?? 'http://localhost:8077';
  const fetchImpl = opts.fetchImpl ?? fetch;

  const res = await fetchImpl(`${endpoint}/figures/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question, figures, topK }),
  });
  if (!res.ok) throw new Error(`figure sidecar HTTP ${res.status}`);

  const parsed = FiguresAnalyzeResponseSchema.parse(await res.json());
  const captionById = new Map(figures.map((f) => [f.figureId, f.caption]));

  const out: FigureReading[] = [];
  for (const r of parsed.readings) {
    // Grounding: only accept a figureId we actually sent; evidenceId is set from our input.
    const caption = captionById.get(r.figureId);
    if (caption === undefined) continue;
    const extractedValues = r.extractedValues.map((v) => {
      const inCaption = captionContainsValue(caption, v.value);
      return { label: v.label, value: v.value, unit: v.unit, inCaption, readRisk: inCaption ? 'low' as const : 'high' as const };
    });
    const figureType: FigureType = FigureTypeSchema.safeParse(r.figureType).success
      ? (r.figureType as FigureType) : 'other';
    out.push({ evidenceId: r.figureId, figureType, reading: r.reading, extractedValues, confidence: r.confidence });
  }
  return out;
}
```

- [ ] **Step 4: Export it**

Add to `packages/mcp-gateway/src/index.ts`:

```typescript
export { readFigures, normalizeNumeric, captionContainsValue } from './figureRead.js';
export type { FigureInput, ReadFiguresOpts } from './figureRead.js';
```

- [ ] **Step 5: Verify JSON import works and tests pass**

Run: `pnpm --filter @mrsirquanzo/sonny-mcp-gateway exec vitest run src/figureRead.test.ts`
Expected: PASS. If the JSON `assert { type: 'json' }` import errors under the repo's TS/vitest config, replace the fixture import in the test with `import fixture from './fixtures/figures-analyze.fixture.json' with { type: 'json' };` or read it via `readFileSync`; keep the fixture as the single source.

- [ ] **Step 6: Type-check**

Run: `pnpm --filter @mrsirquanzo/sonny-mcp-gateway exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-gateway/src/figureRead.ts packages/mcp-gateway/src/figureRead.test.ts packages/mcp-gateway/src/index.ts
git commit -m "feat(mcp-gateway): readFigures - sidecar client with deterministic TS-side inCaption/readRisk"
```

---

## Task 5: Wire the figure step into the researcher, gated by `SONNY_FIGURES`

Split into a testable unit (`researchFigures`) and its wiring, so behavior is covered without faking the specialist model.

**Files:**
- Create: `packages/core/src/figureStep.ts`
- Test: `packages/core/src/figureStep.test.ts`
- Modify: `packages/core/src/researcher.ts`

**Interfaces:**
- Consumes: `pmcFiguresTool`, `readFigures` (from `@mrsirquanzo/sonny-mcp-gateway`); `safeToolCall` (from `./safeToolCall.js`); `EvidenceStore` (from `./evidenceStore.js`); types `TraceEvent`, `FigureReading` (from `@mrsirquanzo/sonny-shared`); `Tool` (from `@mrsirquanzo/sonny-mcp-gateway`).
- Produces:
  - `interface FigureDeps { tool: Tool; read: (o: ReadFiguresOpts) => Promise<FigureReading[]> }`
  - `researchFigures(opts: { pmcid: string; question: string; store: EvidenceStore; emit: (e: TraceEvent) => void; specialist: string; deps?: FigureDeps }): Promise<FigureReading[]>` - registers figures (captions into the store), reads them, emits a `figure_read` trace event, degrades to `[]` text-only on sidecar failure.

### Sub-task 5a: `researchFigures` unit

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/figureStep.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import type { Evidence, TraceEvent, FigureReading } from '@mrsirquanzo/sonny-shared';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import { researchFigures } from './figureStep.js';

function fakeStore() {
  const items: Evidence[] = [];
  return { register: (e: Evidence) => items.push(e), all: () => items, items } as any;
}

const figEvidence: Evidence = {
  id: 'PMCID:PMC1#fig-0', kind: 'figure', source: 'pmc', title: 'Figure 2',
  snippet: 'cap', passage: 'Pooled HR 0.62.', locator: 'fig-0',
  url: 'https://x/bin/g', raw: {}, retrievedAt: 'now',
};
const fakeTool = (evs: Evidence[]): Tool => ({ name: 'pmc_figures', description: '', call: async () => evs });

describe('researchFigures', () => {
  it('registers figures and emits a figure_read event with readings', async () => {
    const store = fakeStore();
    const events: TraceEvent[] = [];
    const readings: FigureReading[] = [{ evidenceId: 'PMCID:PMC1#fig-0', reading: 'r', confidence: 0.8, extractedValues: [{ label: 'HR', value: '0.62', inCaption: true, readRisk: 'low' }] }];
    const out = await researchFigures({
      pmcid: 'PMC1', question: 'q', store, specialist: 's', emit: (e) => events.push(e),
      deps: { tool: fakeTool([figEvidence]), read: async () => readings },
    });
    expect(store.items).toHaveLength(1);
    expect(events.some((e) => e.type === 'evidence_registered' && (e as any).id === 'PMCID:PMC1#fig-0')).toBe(true);
    const fr = events.find((e) => e.type === 'figure_read') as any;
    expect(fr.readings).toEqual(readings);
    expect(out).toEqual(readings);
  });

  it('degrades to [] text-only when the sidecar read throws (no figure_read event)', async () => {
    const store = fakeStore();
    const events: TraceEvent[] = [];
    const out = await researchFigures({
      pmcid: 'PMC1', question: 'q', store, specialist: 's', emit: (e) => events.push(e),
      deps: { tool: fakeTool([figEvidence]), read: async () => { throw new Error('figure sidecar HTTP 503'); } },
    });
    expect(out).toEqual([]);
    expect(events.some((e) => e.type === 'figure_read')).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(store.items).toHaveLength(1); // figures still registered; only the reading failed
  });

  it('returns [] when no figures are found', async () => {
    const store = fakeStore();
    const out = await researchFigures({
      pmcid: 'PMC1', question: 'q', store, specialist: 's', emit: () => {},
      deps: { tool: fakeTool([]), read: async () => { throw new Error('should not be called'); } },
    });
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mrsirquanzo/sonny-core exec vitest run src/figureStep.test.ts`
Expected: FAIL (`figureStep.js` does not exist).

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/figureStep.ts`:

```typescript
import type { TraceEvent, FigureReading } from '@mrsirquanzo/sonny-shared';
import type { Tool, ReadFiguresOpts } from '@mrsirquanzo/sonny-mcp-gateway';
import { pmcFiguresTool, readFigures } from '@mrsirquanzo/sonny-mcp-gateway';
import type { EvidenceStore } from './evidenceStore.js';
import { safeToolCall } from './safeToolCall.js';

export interface FigureDeps {
  tool: Tool;
  read: (o: ReadFiguresOpts) => Promise<FigureReading[]>;
}

const DEFAULT_DEPS: FigureDeps = { tool: pmcFiguresTool, read: readFigures };

export async function researchFigures(opts: {
  pmcid: string;
  question: string;
  store: EvidenceStore;
  emit: (e: TraceEvent) => void;
  specialist: string;
  deps?: FigureDeps;
}): Promise<FigureReading[]> {
  const deps = opts.deps ?? DEFAULT_DEPS;
  // pmc_figures is a Tool returning Evidence[]; safeToolCall degrades it to [] on failure.
  const figs = await safeToolCall({ tool: deps.tool, args: { pmcid: opts.pmcid }, emit: opts.emit });
  if (figs.length === 0) return [];
  for (const f of figs) {
    opts.store.register(f);
    opts.emit({ type: 'evidence_registered', id: f.id, title: f.title });
  }
  const figures = figs.map((f) => ({ figureId: f.id, imageUrl: f.url, caption: f.passage ?? '' }));
  let readings: FigureReading[] = [];
  try {
    readings = await deps.read({ question: opts.question, figures });
  } catch (err) {
    // Figures are additive, never load-bearing: degrade to text-only.
    opts.emit({ type: 'error', message: `figure_read failed: ${String(err)}` });
    return [];
  }
  opts.emit({ type: 'figure_read', specialist: opts.specialist, readings });
  return readings;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @mrsirquanzo/sonny-core exec vitest run src/figureStep.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/figureStep.ts packages/core/src/figureStep.test.ts
git commit -m "feat(core): researchFigures step - register figures, read, emit figure_read, degrade text-only"
```

### Sub-task 5b: wire into `runResearcher`

- [ ] **Step 1: Add the import**

In `packages/core/src/researcher.ts`, near the other core imports (around line 48), add:

```typescript
import { researchFigures } from './figureStep.js';
```

- [ ] **Step 2: Call the step after the skeptic audit, gated by the flag**

In `runResearcher`, inside the `if (top) { ... }` block, immediately after the skeptic-audit `try/catch` (currently ends at line 132) and before the `if (!snowballed)` block, insert:

```typescript
      // Figures: additive, gated, and degrades text-only. Captions land in the
      // store here and flow into extractClaims via store.all() below.
      if (process.env.SONNY_FIGURES !== 'off') {
        await researchFigures({ pmcid, question: item.question, store, emit, specialist: brief.id });
      }
```

(`pmcid` is already in scope from line 113; `item` from line 98.)

- [ ] **Step 3: Run the core suite to confirm no regression**

Run: `pnpm --filter @mrsirquanzo/sonny-core exec vitest run`
Expected: PASS. Existing `runResearcher` tests use a fake fetch, so `pmc_figures`'s real fetch fails and `safeToolCall` degrades it to `[]` (text-only) - the figure step is a no-op in those tests and nothing regresses.

- [ ] **Step 4: Type-check the package**

Run: `pnpm --filter @mrsirquanzo/sonny-core exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/researcher.ts
git commit -m "feat(core): wire researchFigures into runResearcher deep-read, gated by SONNY_FIGURES"
```

---

## Task 6: Eval hook - `figure_grounding` metric + absolute floor (Slice 1 dependent)

Requires the Slice 1 eval harness (`eval` with `metrics.ts`, `scorecard.ts`, `runner.ts`, `golden/`). If Slice 1 is not merged, stop after Task 5 and resume here once it is.

**Files:**
- Modify: `eval/src/metrics.ts`
- Modify: `eval/src/scorecard.ts`
- Modify: `eval/src/runner.ts`
- Test: `eval/src/metrics.test.ts` (create if absent)
- Create: `eval/golden/verdict/<TARGET>.figures.json` (from Task 0)
- Modify: `eval/golden/verdict/_subset.json`

**Interfaces:**
- Consumes: `RunArtifacts`, `MetricResult`, `allClaims` (from `metrics.ts`); `FigureReading` (from `@mrsirquanzo/sonny-shared`); `checkRegression`, `REGRESSION_TOLERANCE` (from `scorecard.ts`); Task 0's confirmed target.
- Produces:
  - `RunArtifacts` gains `figureReadings?: FigureReading[]`.
  - `figureGrounding(a: RunArtifacts): MetricResult` (name `'figure_grounding'`).
  - `ABSOLUTE_FLOORS` map in `scorecard.ts` + a `belowFloor` arm in `checkRegression`.

- [ ] **Step 1: Write the failing metric test**

Create/extend `eval/src/metrics.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { figureGrounding, type RunArtifacts } from './metrics.js';

function artifacts(claims: { text: string; citations: string[] }[], figureReadings: any[]): RunArtifacts {
  return {
    briefing: { verdict: 'watch', sections: [{ id: 's', claims: claims.map((c, i) => ({ id: `c${i}`, ...c })) }] },
    evidenceById: new Map(), elapsedMs: 0, figureReadings,
  } as unknown as RunArtifacts;
}

const lowReading = { evidenceId: 'PMCID:P#fig-0', reading: 'r', confidence: 0.8, extractedValues: [{ label: 'HR', value: '0.62', inCaption: true, readRisk: 'low' }] };
const highReading = { evidenceId: 'PMCID:P#fig-1', reading: 'r', confidence: 0.8, extractedValues: [{ label: 'HR', value: '0.41', inCaption: false, readRisk: 'high' }] };

describe('figureGrounding', () => {
  it('is not gated (pass) when n < 3, reporting the denominator', () => {
    const a = artifacts([{ text: 'HR 0.62', citations: ['PMCID:P#fig-0'] }], [lowReading]);
    const m = figureGrounding(a);
    expect((m.detail as any).n).toBe(1);
    expect(m.pass).toBe(true);
  });

  it('scores fraction caption-anchored and fails below the floor when gated (n>=3)', () => {
    const a = artifacts([
      { text: 'a', citations: ['PMCID:P#fig-1'] },
      { text: 'b', citations: ['PMCID:P#fig-1'] },
      { text: 'c', citations: ['PMCID:P#fig-1'] },
      { text: 'd', citations: ['PMCID:P#fig-0'] },
    ], [lowReading, highReading]);
    const m = figureGrounding(a);
    expect((m.detail as any).n).toBe(4);
    expect(m.score).toBeCloseTo(0.25, 5); // only the fig-0 claim is anchored
    expect(m.pass).toBe(false);           // 0.25 < 0.5 floor
  });

  it('ignores non-figure claims (returns 1.0 when no figure claims)', () => {
    const a = artifacts([{ text: 'x', citations: ['PMID:1'] }], []);
    expect(figureGrounding(a).score).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sonny/eval exec vitest run src/metrics.test.ts`
Expected: FAIL (`figureGrounding` not exported; `figureReadings` not on `RunArtifacts`).

- [ ] **Step 3: Extend `RunArtifacts` and add the metric**

In `eval/src/metrics.ts`, add `figureReadings` to the `RunArtifacts` interface:

```typescript
  figureReadings?: import('@mrsirquanzo/sonny-shared').FigureReading[];
```

Then add the metric (mirrors the `MetricResult` shape used by the other deterministic metrics; `allClaims` already exists in this file):

```typescript
const FLOOR_FIGURE_GROUNDING = 0.5;

/**
 * figure_grounding: of claims citing a figure evidence id, the fraction whose
 * cited figures are caption-anchored (have a low-risk value). Guards against a
 * dossier filling up with pixel-guessed numbers. A distribution, so it is a
 * band (scorecard REGRESSION_TOLERANCE) plus an absolute floor (ABSOLUTE_FLOORS),
 * gated only when n >= 3.
 */
export function figureGrounding(a: RunArtifacts): MetricResult {
  const isFig = (id: string) => id.includes('#fig-');
  const figClaims = allClaims(a.briefing).filter((c) => c.citations.some(isFig));
  const n = figClaims.length;
  const anchored = new Set<string>();
  for (const r of a.figureReadings ?? []) {
    if (r.extractedValues.some((v) => v.readRisk === 'low')) anchored.add(r.evidenceId);
  }
  const low = figClaims.filter((c) =>
    c.citations.filter(isFig).every((id) => anchored.has(id)),
  ).length;
  const score = n ? low / n : 1;
  const gated = n >= 3;
  return {
    name: 'figure_grounding',
    score,
    pass: gated ? score >= FLOOR_FIGURE_GROUNDING : true,
    detail: { n, low, gated, floor: FLOOR_FIGURE_GROUNDING },
  };
}
```

- [ ] **Step 4: Run the metric test to verify it passes**

Run: `pnpm --filter @sonny/eval exec vitest run src/metrics.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the absolute floor to `scorecard.ts`**

In `eval/src/scorecard.ts`, add a band entry and the floor map:

```typescript
// beside REGRESSION_TOLERANCE:
export const ABSOLUTE_FLOORS: Record<string, number> = {
  figure_grounding: 0.5, // calibrate after the first real figure runs
};
```

Add `figure_grounding: 0.1` to `REGRESSION_TOLERANCE`. Extend `RegressionResult` with `belowFloor: { metric: string; floor: number; current: number }[]`, and in `checkRegression`, before the return, compute it baseline-independently (the same discipline as `grounding_integrity`'s hard fail):

```typescript
  const belowFloor: RegressionResult['belowFloor'] = [];
  for (const [metric, floor] of Object.entries(ABSOLUTE_FLOORS)) {
    const cur = sc.aggregates[metric];
    if (cur !== undefined && cur < floor) belowFloor.push({ metric, floor, current: cur });
  }
```

Return `{ regressed, hardFailures, belowFloor }`.

- [ ] **Step 6: Treat a floor breach as failure in the runner**

In `eval/src/runner.ts`, add `figureGrounding(a)` to the `metrics` array in `scoreTarget` (alongside the other deterministic metrics), and in `runEval` extend the failure condition:

```typescript
  const failed = reg.hardFailures.length > 0 || reg.regressed.length > 0 || reg.belowFloor.length > 0;
```

and log `reg.belowFloor` when it is non-empty.

- [ ] **Step 7: Populate `figureReadings` in `runOnce`**

In the runner's `runOnce` wiring (where `RunArtifacts` is assembled from the trace), collect the figure readings from the `figure_read` trace events:

```typescript
  const figureReadings = events.flatMap((e) => e.type === 'figure_read' ? e.readings : []);
  // include figureReadings in the returned RunArtifacts
```

- [ ] **Step 8: Add the confirmed golden target and mark it fast**

Create `eval/golden/verdict/<TARGET>.figures.json` using Task 0's confirmed values, following the `GoldenTarget` schema, with a `claimProbe` whose `statement` is Task 0's probe and `expected: "supported"` (the figures-on run must assert the figure HR). Add the target symbol to the `fast` array in `eval/golden/verdict/_subset.json`.

- [ ] **Step 9: Prove the lift (the whole point of the slice)**

Run the target both ways:

```bash
SONNY_FIGURES=off pnpm --filter @sonny/eval exec tsx src/runner.ts --subset fast
SONNY_FIGURES=on  pnpm --filter @sonny/eval exec tsx src/runner.ts --subset fast
```

Expected: the `claim_probes` metric for the figure target FAILS with `SONNY_FIGURES=off` and PASSES with `SONNY_FIGURES=on`. That delta is the measured proof. Capture both scorecards.

- [ ] **Step 10: Commit**

```bash
git add eval/src/metrics.ts eval/src/metrics.test.ts eval/src/scorecard.ts eval/src/runner.ts eval/golden/verdict/
git commit -m "feat(eval): figure_grounding metric (band + absolute floor + n>=3 gate) and figure-heavy golden target"
```

---

## Self-Review

**Spec coverage:**
- Contract (Evidence.kind figure, FigureReading, wire schemas, trace event) - Task 1.
- `pmc_figures` Tool, caption as passage, throw on non-OK - Task 2.
- Shared wire-shape fixture, contract of record - Task 3.
- `readFigures`, deterministic TS-side `inCaption`, binary `readRisk`, numeric normalization, ids-set-in-code - Task 4.
- `researcher.ts` wiring after skeptic audit, `figure_read` trace event, text-only degrade, `SONNY_FIGURES` gate - Task 5.
- `figure_grounding` band + absolute floor + `n>=3` gate; operational golden target; figures-off/on lift proof - Tasks 0 and 6.
- Slice 4b (Python sidecar, Pydantic round-trip against the same fixture, reader model choice) - explicitly out of scope; the fixture (Task 3) is the seam that makes it a clean follow-up.

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to". Task 6's golden JSON values come from Task 0's operational output, which is that task's defined deliverable, not a placeholder.

**Type consistency:** `readFigures`/`FigureInput`/`ReadFiguresOpts` names match across Tasks 4 and 5. `figure_read` trace event `{ specialist, readings }` matches Task 1's union and Task 5's emit and Task 6's `runOnce` collector. `figureGrounding` reads `readRisk === 'low'` and claim citations containing `#fig-`, consistent with Task 2's id format (`PMCID:...#fig-<i>`) and Task 4's `readRisk` derivation.

**Known deviation from the spec, by design:** the spec called `figure_read` a "Tool with the same uniform interface," but the repo's `Tool` returns `Evidence[]`; since `figure_read` returns `FigureReading[]` it is a standalone `readFigures()` function, and `researchFigures` provides the `safeToolCall`-style degrade. This is the faithful realization of the spec's intent in this codebase.
