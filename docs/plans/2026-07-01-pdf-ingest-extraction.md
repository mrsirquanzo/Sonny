# Patent Ingest and Region-Extraction Implementation Plan (Patent Specialist - Slice 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn an uploaded patent file into a flat `ExtractedPatent` (patent number, SEQ ID NO -> residues, region-label -> SEQ ID associations) via MarkItDown ingest, regex sequence extraction, and LLM association extraction, exposed as a CLI command.

**Architecture:** `packages/mcp-gateway` gets `ingestToMarkdown` (markitdown subprocess) and the pure regex extractors. `packages/core` gets the LLM `extractAssociations` and the `extractPatentData` assembly (needs `StructuredModel`). `apps/cli` gets an `extract-patent <file>` command. The LLM extracts region-to-SEQ-ID associations only; a regex owns residues; BLAST (slice 1) is the correctness backstop.

**Tech Stack:** TypeScript ESM, Vitest, Node `child_process`, MarkItDown CLI (`markitdown` 0.1.6), Zod. Test runner: `pnpm --filter @sonny/<pkg> test`.

**Spec:** [docs/specs/2026-07-01-pdf-ingest-extraction-design.md](../specs/2026-07-01-pdf-ingest-extraction-design.md).

## Global Constraints

- Never use the em dash; use a plain hyphen.
- Never auto-add a commit co-author.
- ESM relative imports use the `.js` extension; all imports at the top of the module.
- The LLM extracts region-to-SEQ-ID associations only; it must NEVER transcribe residues. Residues come from the regex sequence listing.
- `ingestToMarkdown` and `extractAssociations` NEVER throw; they soft-degrade (`markitdown_unavailable` / `[]`).
- Grouping SEQ IDs into antibody constructs is out of scope (slice 5).
- Touch only the files named in each task.

## File Structure

- Create: `packages/mcp-gateway/src/ingest.ts` + test - markitdown subprocess.
- Create: `packages/mcp-gateway/src/patentExtract.ts` + test - regex extractors.
- Modify: `packages/mcp-gateway/src/index.ts` - export the above.
- Create: `packages/core/src/patentData.ts` + test - LLM associations + assembly.
- Modify: `packages/core/src/index.ts` - export `extractPatentData` etc.
- Create: `apps/cli/src/extractPatent.ts` + test - `runExtractPatent`.
- Modify: `apps/cli/src/run.ts` - route the `extract-patent` command.

---

### Task 1: `ingestToMarkdown` (MarkItDown subprocess)

**Files:**
- Create: `packages/mcp-gateway/src/ingest.ts`
- Test: `packages/mcp-gateway/src/ingest.test.ts`
- Modify: `packages/mcp-gateway/src/index.ts`

**Interfaces:**
- Produces: `type MarkitdownExec = (filePath: string) => Promise<{ stdout: string; stderr: string; code: number }>`; `interface IngestResult { markdown: string; status: 'ok' | 'markitdown_unavailable'; error?: string }`; `ingestToMarkdown(filePath: string, deps?: { exec?: MarkitdownExec }): Promise<IngestResult>`.

- [ ] **Step 1: Write the failing tests**

Create `packages/mcp-gateway/src/ingest.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ingestToMarkdown } from './ingest.js';
import type { MarkitdownExec } from './ingest.js';

describe('ingestToMarkdown', () => {
  it('returns markdown with status ok on exit code 0', async () => {
    const exec: MarkitdownExec = async () => ({ stdout: '# Patent\nSEQ ID NO: 1', stderr: '', code: 0 });
    const r = await ingestToMarkdown('/x.pdf', { exec });
    expect(r.status).toBe('ok');
    expect(r.markdown).toBe('# Patent\nSEQ ID NO: 1');
  });

  it('soft-degrades to markitdown_unavailable on a spawn error (code -1) without throwing', async () => {
    const exec: MarkitdownExec = async () => ({ stdout: '', stderr: 'spawn markitdown ENOENT', code: -1 });
    const r = await ingestToMarkdown('/x.pdf', { exec });
    expect(r.status).toBe('markitdown_unavailable');
    expect(r.markdown).toBe('');
    expect(r.error).toContain('ENOENT');
  });

  it('soft-degrades on a non-zero exit', async () => {
    const exec: MarkitdownExec = async () => ({ stdout: '', stderr: 'bad file', code: 2 });
    const r = await ingestToMarkdown('/x.pdf', { exec });
    expect(r.status).toBe('markitdown_unavailable');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/mcp-gateway test -- ingest`
Expected: FAIL - `ingest.js` does not exist yet.

- [ ] **Step 3: Implement the ingest**

Create `packages/mcp-gateway/src/ingest.ts`:

```ts
import { spawn } from 'node:child_process';

export type MarkitdownExec = (filePath: string) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface IngestResult {
  markdown: string;
  status: 'ok' | 'markitdown_unavailable';
  error?: string;
}

const defaultExec: MarkitdownExec = (filePath) =>
  new Promise((resolve) => {
    const bin = process.env.SONNY_MARKITDOWN ?? 'markitdown';
    const child = spawn(bin, [filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e: Error) => resolve({ stdout: '', stderr: String(e), code: -1 }));
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });

export async function ingestToMarkdown(
  filePath: string,
  deps: { exec?: MarkitdownExec } = {},
): Promise<IngestResult> {
  const exec = deps.exec ?? defaultExec;
  const { stdout, stderr, code } = await exec(filePath);
  if (code !== 0) {
    return { markdown: '', status: 'markitdown_unavailable', error: `markitdown exit ${code}: ${stderr.trim()}`.trim() };
  }
  return { markdown: stdout, status: 'ok' };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/mcp-gateway test -- ingest`
Expected: PASS.

- [ ] **Step 5: Export from the gateway index**

In `packages/mcp-gateway/src/index.ts`, add below the existing exports:

```ts
export { ingestToMarkdown } from './ingest.js';
export type { MarkitdownExec, IngestResult } from './ingest.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-gateway/src/ingest.ts packages/mcp-gateway/src/ingest.test.ts packages/mcp-gateway/src/index.ts
git commit -m "feat(mcp-gateway): add ingestToMarkdown MarkItDown subprocess bridge"
```

---

### Task 2: Regex extractors (`extractPatentNumber`, `extractSequenceListing`)

**Files:**
- Create: `packages/mcp-gateway/src/patentExtract.ts`
- Test: `packages/mcp-gateway/src/patentExtract.test.ts`
- Modify: `packages/mcp-gateway/src/index.ts`

**Interfaces:**
- Consumes: `normalizePatentNumber` from `./epoPatent.js`.
- Produces: `interface ExtractedSequence { seqId: number; residues: string }`; `extractPatentNumber(markdown: string): string | null`; `extractSequenceListing(markdown: string): ExtractedSequence[]`.

- [ ] **Step 1: Write the failing tests**

Create `packages/mcp-gateway/src/patentExtract.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { extractPatentNumber, extractSequenceListing } from './patentExtract.js';

describe('extractPatentNumber', () => {
  it('finds and normalizes a patent number embedded in text', () => {
    expect(extractPatentNumber('Filed as Patent No. US 10,123,456 B2 on ...')).toBe('US10123456');
  });
  it('returns null when no valid patent number is present', () => {
    expect(extractPatentNumber('This document has no patent number.')).toBeNull();
  });
});

describe('extractSequenceListing', () => {
  it('parses SEQ ID NO blocks into normalized residues, de-dupes ids, skips empty', () => {
    const md = [
      'SEQ ID NO: 1',
      'EVQLVESGGG',
      '',
      'SEQ ID NO: 2',
      'DIQ MTQ SPSS',   // whitespace inside residues is stripped
      '',
      'SEQ ID NO: 1',   // duplicate id ignored
      'ZZZZZZ',
      '',
      'the CDR-H1 comprises SEQ ID NO: 3 and other text',  // inline ref, no residue block
    ].join('\n');
    const out = extractSequenceListing(md);
    expect(out).toEqual([
      { seqId: 1, residues: 'EVQLVESGGG' },
      { seqId: 2, residues: 'DIQMTQSPSS' },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/mcp-gateway test -- patentExtract`
Expected: FAIL - `patentExtract.js` does not exist yet.

- [ ] **Step 3: Implement the extractors**

Create `packages/mcp-gateway/src/patentExtract.ts`:

```ts
import { normalizePatentNumber } from './epoPatent.js';

export interface ExtractedSequence {
  seqId: number;
  residues: string;
}

// Candidate patent-number strings: 2-letter country, digits (with interior spaces/commas/dots/slashes), optional kind code.
const CANDIDATE = /[A-Z]{2}[  ]?\d[\d,.\s/]{2,}\d(?:[  ]?[A-Z]\d?)?/g;

export function extractPatentNumber(markdown: string): string | null {
  const candidates = markdown.match(CANDIDATE) ?? [];
  for (const c of candidates) {
    const norm = normalizePatentNumber(c.replace(/\//g, ''));
    if (norm) return norm.epodoc;
  }
  return null;
}

function normalizeResidues(raw: string): string {
  return raw.replace(/[^A-Za-z]/g, '').toUpperCase();
}

// Capture the residue block that follows each "SEQ ID NO: N". Group 2 starts with an uppercase
// letter and runs over uppercase/digit/whitespace until the next SEQ ID marker, a blank line, or end.
// Inline references (followed by lowercase prose) do not match group 2 and are skipped.
// The regex is constructed inside the function so its /g lastIndex never leaks across calls.
export function extractSequenceListing(markdown: string): ExtractedSequence[] {
  const listing = /SEQ\s*ID\s*NO[:.\s]*?(\d+)\s*[:.)\-]?\s*\n?([A-Z][A-Z0-9\s]*?)(?=SEQ\s*ID\s*NO|\n\s*\n|$)/gi;
  const out: ExtractedSequence[] = [];
  const seen = new Set<number>();
  let m: RegExpExecArray | null;
  while ((m = listing.exec(markdown)) !== null) {
    const seqId = Number(m[1]);
    if (seen.has(seqId)) continue;
    const residues = normalizeResidues(m[2]);
    if (residues.length < 4) continue;
    seen.add(seqId);
    out.push({ seqId, residues });
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/mcp-gateway test -- patentExtract`
Expected: PASS.

- [ ] **Step 5: Export from the gateway index**

In `packages/mcp-gateway/src/index.ts`, add below the existing exports:

```ts
export { extractPatentNumber, extractSequenceListing } from './patentExtract.js';
export type { ExtractedSequence } from './patentExtract.js';
```

- [ ] **Step 6: Run the full gateway suite**

Run: `pnpm --filter @sonny/mcp-gateway test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-gateway/src/patentExtract.ts packages/mcp-gateway/src/patentExtract.test.ts packages/mcp-gateway/src/index.ts
git commit -m "feat(mcp-gateway): add patent-number and sequence-listing regex extractors"
```

---

### Task 3: `extractAssociations` and `extractPatentData` (core)

**Files:**
- Create: `packages/core/src/patentData.ts`
- Test: `packages/core/src/patentData.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `StructuredModel`, `MODEL_ROUTER` from `./model.js`; `extractPatentNumber`, `extractSequenceListing`, `ExtractedSequence`, `RegionLabel` from `@sonny/mcp-gateway`.
- Produces: `interface RegionAssociation { regionLabel: RegionLabel; seqId: number; residues?: string }`; `interface ExtractedPatent { patentNumber: string | null; sequences: ExtractedSequence[]; associations: RegionAssociation[] }`; `extractAssociations(markdown, model): Promise<Array<{ regionLabel: RegionLabel; seqId: number }>>`; `extractPatentData(markdown, model): Promise<ExtractedPatent>`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/patentData.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { extractPatentData, extractAssociations } from './patentData.js';
import type { StructuredModel } from './model.js';

const MD = [
  'Patent US 10,123,456 B2',
  'Claims',
  '1. An antibody comprising CDR-H1 of SEQ ID NO: 1.',
  '',
  'SEQ ID NO: 1',
  'EVQLVESGGG',
  '',
  'SEQ ID NO: 2',
  'DIQMTQSPSS',
  '',
].join('\n');

function mockModel(assoc: Array<{ regionLabel: string; seqId: number }>): StructuredModel {
  return { async generateStructured() { return { associations: assoc } as never; } };
}

describe('extractPatentData', () => {
  it('assembles patent number, sequences, and associations with residues joined by seqId', async () => {
    const data = await extractPatentData(MD, mockModel([{ regionLabel: 'CDR-H1', seqId: 1 }]));
    expect(data.patentNumber).toBe('US10123456');
    expect(data.sequences).toEqual([{ seqId: 1, residues: 'EVQLVESGGG' }, { seqId: 2, residues: 'DIQMTQSPSS' }]);
    expect(data.associations).toEqual([{ regionLabel: 'CDR-H1', seqId: 1, residues: 'EVQLVESGGG' }]);
  });

  it('leaves residues undefined when the listing lacks the seqId', async () => {
    const data = await extractPatentData(MD, mockModel([{ regionLabel: 'CDR-H3', seqId: 99 }]));
    expect(data.associations[0].residues).toBeUndefined();
  });
});

describe('extractAssociations', () => {
  it('returns [] when the model throws', async () => {
    const throwing: StructuredModel = { async generateStructured() { throw new Error('boom'); } };
    expect(await extractAssociations(MD, throwing)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/core test -- patentData`
Expected: FAIL - `patentData.js` does not exist yet.

- [ ] **Step 3: Implement the module**

Create `packages/core/src/patentData.ts`:

```ts
import { z } from 'zod';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';
import { extractPatentNumber, extractSequenceListing } from '@sonny/mcp-gateway';
import type { ExtractedSequence, RegionLabel } from '@sonny/mcp-gateway';

export interface RegionAssociation {
  regionLabel: RegionLabel;
  seqId: number;
  residues?: string;
}

export interface ExtractedPatent {
  patentNumber: string | null;
  sequences: ExtractedSequence[];
  associations: RegionAssociation[];
}

const REGION_LABELS = [
  'VH', 'VL', 'CDR-H1', 'CDR-H2', 'CDR-H3', 'CDR-L1', 'CDR-L2', 'CDR-L3',
  'FR-H1', 'FR-H2', 'FR-H3', 'FR-H4', 'FR-L1', 'FR-L2', 'FR-L3', 'FR-L4',
  'Fc', 'CH1', 'CL', 'hinge', 'heavy-chain', 'light-chain', 'Fab',
] as const;

const AssocSchema = z.object({
  associations: z.array(z.object({ regionLabel: z.enum(REGION_LABELS), seqId: z.number() })),
});

const SYSTEM =
  'You extract antibody region-to-SEQ-ID mappings from patent text. For each place the text maps an antibody region designation (VH, VL, CDR-H1/2/3, CDR-L1/2/3, Fc, Fab, heavy chain, light chain, and similar) to a SEQ ID NO, output { regionLabel, seqId }. Only output mappings explicitly stated in the text. Never transcribe or output sequences.';

const INPUT_CAP = 50000;

// Patents can exceed the model context; bound the input and prefer the claims window where associations live.
function boundForClaims(markdown: string): string {
  const idx = markdown.search(/claims/i);
  const start = idx >= 0 ? idx : 0;
  return markdown.slice(start, start + INPUT_CAP);
}

export async function extractAssociations(
  markdown: string,
  model: StructuredModel,
): Promise<Array<{ regionLabel: RegionLabel; seqId: number }>> {
  try {
    const out = await model.generateStructured({
      system: SYSTEM,
      prompt: boundForClaims(markdown),
      schema: AssocSchema,
      model: MODEL_ROUTER.specialist,
    });
    return out.associations;
  } catch {
    return [];
  }
}

export async function extractPatentData(markdown: string, model: StructuredModel): Promise<ExtractedPatent> {
  const patentNumber = extractPatentNumber(markdown);
  const sequences = extractSequenceListing(markdown);
  const associations = await extractAssociations(markdown, model);
  const byId = new Map(sequences.map((s) => [s.seqId, s.residues]));
  return {
    patentNumber,
    sequences,
    associations: associations.map((a) => ({ ...a, residues: byId.get(a.seqId) })),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/core test -- patentData`
Expected: PASS.

- [ ] **Step 5: Export from the core index**

In `packages/core/src/index.ts`, add below the existing exports:

```ts
export { extractPatentData, extractAssociations, type ExtractedPatent, type RegionAssociation } from './patentData.js';
```

- [ ] **Step 6: Run the full core suite**

Run: `pnpm --filter @sonny/core test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/patentData.ts packages/core/src/patentData.test.ts packages/core/src/index.ts
git commit -m "feat(core): add extractPatentData with LLM region-association extraction"
```

---

### Task 4: CLI `extract-patent` command

**Files:**
- Create: `apps/cli/src/extractPatent.ts`
- Test: `apps/cli/src/extractPatent.test.ts`
- Modify: `apps/cli/src/run.ts`

**Interfaces:**
- Consumes: `ingestToMarkdown` from `@sonny/mcp-gateway`; `extractPatentData`, `makeModel`, `StructuredModel`, `ExtractedPatent` from `@sonny/core`.
- Produces: `runExtractPatent(filePath, deps?): Promise<{ ok: true; data: ExtractedPatent } | { ok: false; error: string }>`.

- [ ] **Step 1: Write the failing tests**

Create `apps/cli/src/extractPatent.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { runExtractPatent } from './extractPatent.js';
import type { StructuredModel } from '@sonny/core';

const model: StructuredModel = {
  async generateStructured() { return { associations: [{ regionLabel: 'CDR-H1', seqId: 1 }] } as never; },
};

describe('runExtractPatent', () => {
  it('ingests then extracts, returning the ExtractedPatent', async () => {
    const ingest = async () => ({ markdown: 'US 10,123,456 B2\nSEQ ID NO: 1\nEVQLVESGGG\n', status: 'ok' as const });
    const out = await runExtractPatent('/x.pdf', { ingest, model });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.patentNumber).toBe('US10123456');
      expect(out.data.associations[0]).toEqual({ regionLabel: 'CDR-H1', seqId: 1, residues: 'EVQLVESGGG' });
    }
  });

  it('returns ok:false when markitdown is unavailable', async () => {
    const ingest = async () => ({ markdown: '', status: 'markitdown_unavailable' as const, error: 'not installed' });
    const out = await runExtractPatent('/x.pdf', { ingest });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('not installed');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/cli test -- extractPatent`
Expected: FAIL - `extractPatent.js` does not exist yet.

- [ ] **Step 3: Implement `runExtractPatent`**

Create `apps/cli/src/extractPatent.ts`:

```ts
import { ingestToMarkdown } from '@sonny/mcp-gateway';
import type { IngestResult } from '@sonny/mcp-gateway';
import { extractPatentData, makeModel } from '@sonny/core';
import type { StructuredModel, ExtractedPatent } from '@sonny/core';

export interface ExtractPatentDeps {
  ingest?: (filePath: string) => Promise<IngestResult>;
  model?: StructuredModel;
}

export async function runExtractPatent(
  filePath: string,
  deps: ExtractPatentDeps = {},
): Promise<{ ok: true; data: ExtractedPatent } | { ok: false; error: string }> {
  const ingest = deps.ingest ?? ((f: string) => ingestToMarkdown(f));
  const res = await ingest(filePath);
  if (res.status !== 'ok') return { ok: false, error: res.error ?? 'markitdown unavailable' };
  const model = deps.model ?? makeModel();
  const data = await extractPatentData(res.markdown, model);
  return { ok: true, data };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/cli test -- extractPatent`
Expected: PASS.

- [ ] **Step 5: Wire the command into `run.ts`**

In `apps/cli/src/run.ts`, add this import at the top with the other imports:

```ts
import { runExtractPatent } from './extractPatent.js';
```

Then, as the FIRST statement inside `export async function main(argv: string[])` (before the existing `if (argv[2] === 'deep')` branch):

```ts
  if (argv[2] === 'extract-patent') {
    const file = argv[3];
    if (!file) { console.error('usage: extract-patent <file>'); process.exit(1); return; }
    const out = await runExtractPatent(file);
    if (!out.ok) { console.error(out.error); process.exit(1); return; }
    console.log(JSON.stringify(out.data, null, 2));
    return;
  }
```

(The `main` wiring is a thin shell with process side effects and is not unit-tested, consistent with the existing `main`; `runExtractPatent` carries the tested logic.)

- [ ] **Step 6: Run the full CLI suite**

Run: `pnpm --filter @sonny/cli test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/extractPatent.ts apps/cli/src/extractPatent.test.ts apps/cli/src/run.ts
git commit -m "feat(cli): add extract-patent command wiring MarkItDown ingest to extractPatentData"
```

---

## Notes for the controller

- Manual smoke (not a unit test): `SONNY_BACKEND=ollama pnpm --filter @sonny/cli exec tsx src/index.ts extract-patent <real-antibody-patent.pdf>`. Confirm markitdown conversion, the sequence-listing regex against the real converted text, the claims-window bounding, and the LLM associations. Tune the `LISTING`/`CANDIDATE` regexes and `INPUT_CAP` against real output; the TypeScript contracts stay fixed.
- Out of scope: grouping into antibody constructs, the web upload surface, EPO/BLAST reconciliation (all slice 5).
