# H1b Live-Tier Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Build the opt-in live eval tier for the patent specialist (capability gating, golden loading, live runner, metrics roll-up) plus close the H4 offline minor, so the tier is drop-in the moment the user supplies verified goldens + EPO key + ANARCI.

**Architecture:** All new code lives in `eval/` (which may import `@mrsirquanzo/sonny-{shared,core,mcp-gateway}` but NOT `apps/*`). The live runner re-composes the real pipeline inside eval (the `runPatentPipeline` precedent) rather than importing the CLI. The live path is gated behind `SONNY_LIVE=1` + capability probes and never runs in CI.

**Tech Stack:** TypeScript ESM, Vitest, pnpm workspaces.

## Global Constraints

- No em dashes anywhere; use a plain dash.
- No commit co-author trailer.
- `eval` imports only from `@mrsirquanzo/sonny-{shared,core,mcp-gateway}` and node builtins; never from `apps/*`.
- The live tier must be inert under normal `pnpm -r test` / CI: live tests use `it.skipIf(!liveEnabled(...))`, and no live code path runs without `SONNY_LIVE=1`.
- Integrity rule: a golden with `groundTruthVerified !== true` is observe-only; its metrics are printed but never asserted.
- Additive only: do not change tool behavior; the only non-eval edit is wiring `matchCdrCompetitors` into `eval/src/patentPipeline.ts` (Task 4).
- Reuse the existing `goldenPatent.ts` metrics; do not reimplement metric math.
- `eval` package name is `@sonny/eval`; filter it as `pnpm --filter @sonny/eval`.

---

### Task 1: `liveGate.ts` - capability detection

**Files:**
- Create: `eval/src/liveGate.ts`
- Test: `eval/src/liveGate.test.ts`

**Interfaces:**
- Produces: `LiveCapabilities`, `detectLiveCapabilities(env?)`, `liveEnabled(caps)`.

- [ ] **Step 1: Write the failing test**

Create `eval/src/liveGate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { detectLiveCapabilities, liveEnabled } from './liveGate.js';

describe('detectLiveCapabilities', () => {
  it('reports all capabilities present', () => {
    const caps = detectLiveCapabilities({ SONNY_LIVE: '1', ANTHROPIC_API_KEY: 'k', SONNY_EPO_KEY: 'a', SONNY_EPO_SECRET: 'b', SONNY_ANARCI: '1' } as NodeJS.ProcessEnv);
    expect(caps).toMatchObject({ live: true, anthropic: true, epo: true, anarci: true });
    expect(caps.reasons).toEqual([]);
  });

  it('lists reasons for each missing capability', () => {
    const caps = detectLiveCapabilities({ SONNY_LIVE: '1', ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv);
    expect(caps.epo).toBe(false);
    expect(caps.anarci).toBe(false);
    expect(caps.reasons.join(' ')).toContain('EPO');
    expect(caps.reasons.join(' ')).toContain('ANARCI');
  });

  it('liveEnabled requires live + anthropic', () => {
    expect(liveEnabled(detectLiveCapabilities({ SONNY_LIVE: '1', ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv))).toBe(true);
    expect(liveEnabled(detectLiveCapabilities({ ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv))).toBe(false);
    expect(liveEnabled(detectLiveCapabilities({ SONNY_LIVE: '1' } as NodeJS.ProcessEnv))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @sonny/eval test -- liveGate`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `eval/src/liveGate.ts`:

```ts
export interface LiveCapabilities {
  live: boolean;
  anthropic: boolean;
  epo: boolean;
  anarci: boolean;
  reasons: string[];
}

// ANARCI availability is signalled by SONNY_ANARCI=1 (the user sets it after `conda install -c bioconda anarci hmmer`).
// A PATH probe is deferred to the live runner where a spawn is acceptable; detection here stays pure and env-only.
export function detectLiveCapabilities(env: NodeJS.ProcessEnv = process.env): LiveCapabilities {
  const live = env.SONNY_LIVE === '1';
  const anthropic = Boolean(env.ANTHROPIC_API_KEY);
  const epo = Boolean(env.SONNY_EPO_KEY && env.SONNY_EPO_SECRET);
  const anarci = env.SONNY_ANARCI === '1';
  const reasons: string[] = [];
  if (!live) reasons.push('SONNY_LIVE not set (live tier disabled)');
  if (!anthropic) reasons.push('ANTHROPIC_API_KEY missing (no model, cannot run)');
  if (!epo) reasons.push('EPO creds missing (SONNY_EPO_KEY/SECRET): patent identity degrades to EPO_CONFIG_MISSING');
  if (!anarci) reasons.push('ANARCI missing (SONNY_ANARCI!=1): region/species confirm degrades to anarci_unavailable');
  return { live, anthropic, epo, anarci, reasons };
}

export function liveEnabled(caps: LiveCapabilities): boolean {
  return caps.live && caps.anthropic;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @sonny/eval test -- liveGate` (PASS).

- [ ] **Step 5: Commit**

```bash
git add eval/src/liveGate.ts eval/src/liveGate.test.ts
git commit -m "feat(eval): live-tier capability detection (opt-in gate)"
```

---

### Task 2: `groundTruthVerified` + `goldenLoader.ts`

**Files:**
- Modify: `eval/src/goldenPatent.ts` (add optional `groundTruthVerified?: boolean`)
- Create: `eval/src/goldenLoader.ts`
- Rename: `eval/golden/synthetic-antibody.json` -> `eval/golden/synthetic-antibody.patent.json`
- Modify: any test reading the old fixture path (see Step 4)
- Test: `eval/src/goldenLoader.test.ts`

**Interfaces:**
- Consumes: `GoldenPatent` from `./goldenPatent.js`.
- Produces: `LoadedGolden`, `loadGoldens(dir?)`.

- [ ] **Step 1: Add the field**

In `eval/src/goldenPatent.ts`, add to the `GoldenPatent` interface (after `traps?`):

```ts
  groundTruthVerified?: boolean;
```

- [ ] **Step 2: Rename the fixture**

```bash
git mv eval/golden/synthetic-antibody.json eval/golden/synthetic-antibody.patent.json
```

- [ ] **Step 3: Write the failing test**

Create `eval/src/goldenLoader.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadGoldens } from './goldenLoader.js';

describe('loadGoldens', () => {
  it('loads the synthetic golden and defaults groundTruthVerified to false', () => {
    const loaded = loadGoldens();
    const syn = loaded.find((l) => l.golden.name === 'synthetic-antibody');
    expect(syn).toBeDefined();
    expect(syn?.groundTruthVerified).toBe(false);
    expect(syn?.golden.patentNumber).toBe('US10123456');
    expect(syn?.sourceFile).toContain('synthetic-antibody.patent.json');
  });

  it('returns an empty list for a directory with no patent goldens', () => {
    expect(loadGoldens(new URL('./', import.meta.url).pathname)).toEqual([]);
  });
});
```

- [ ] **Step 4: Run to verify fail (and find the old-path reader)**

Run: `pnpm --filter @sonny/eval test`
Expected: `goldenLoader` FAILs (module not found). ALSO: if the existing `patentPipeline.test.ts` (or any test) reads `synthetic-antibody.json`, it now fails on the renamed path. Grep `git grep -n "synthetic-antibody.json"` and update every hit to `synthetic-antibody.patent.json`.

- [ ] **Step 5: Implement the loader**

Create `eval/src/goldenLoader.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GoldenPatent } from './goldenPatent.js';

export interface LoadedGolden { golden: GoldenPatent; groundTruthVerified: boolean; sourceFile: string }

const REQUIRED: Array<keyof GoldenPatent> = ['name', 'patentNumber', 'declaredSequenceCount', 'knownSequences', 'expectedConstructs'];

function validate(obj: unknown, file: string): GoldenPatent {
  if (typeof obj !== 'object' || obj === null) throw new Error(`golden ${file}: not an object`);
  for (const k of REQUIRED) {
    if (!(k in obj)) throw new Error(`golden ${file}: missing required field "${String(k)}"`);
  }
  return obj as GoldenPatent;
}

export function loadGoldens(dir?: string): LoadedGolden[] {
  const base = dir ?? fileURLToPath(new URL('../golden/', import.meta.url));
  let files: string[];
  try { files = readdirSync(base).filter((f) => f.endsWith('.patent.json')); }
  catch { return []; }
  return files.map((f) => {
    const sourceFile = `${base.replace(/\/$/, '')}/${f}`;
    const golden = validate(JSON.parse(readFileSync(sourceFile, 'utf8')), f);
    return { golden, groundTruthVerified: golden.groundTruthVerified === true, sourceFile };
  });
}
```

- [ ] **Step 6: Run to verify pass**

Run: `pnpm --filter @sonny/eval test` (PASS - loader tests + the updated fixture-path reader).

- [ ] **Step 7: Commit**

```bash
git add eval/src/goldenPatent.ts eval/src/goldenLoader.ts eval/src/goldenLoader.test.ts eval/golden/ eval/src/patentPipeline.test.ts
git commit -m "feat(eval): golden loader with validation and verified-ground-truth flag"
```

---

### Task 3: `patentScore.ts` - metrics roll-up

**Files:**
- Create: `eval/src/patentScore.ts`
- Test: `eval/src/patentScore.test.ts`

**Interfaces:**
- Consumes: metrics from `./goldenPatent.js`; `gotConstructs`, `gotCompetitorOverlaps` from `./patentPipeline.js`; `PatentWorkup` from `@mrsirquanzo/sonny-core`.
- Produces: `PatentMetrics`, `scorePatent(workup, golden)`.

- [ ] **Step 1: Write the failing test**

Create `eval/src/patentScore.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { scorePatent } from './patentScore.js';
import type { GoldenPatent } from './goldenPatent.js';
import type { PatentWorkup } from '@mrsirquanzo/sonny-core';

const golden: GoldenPatent = {
  name: 'g', patentNumber: 'US1', expectedAssignees: ['ACME'], expectedFamilyMembers: ['EP1'],
  declaredSequenceCount: 2, knownSequences: [{ seqId: 1, residues: 'EVQL' }],
  expectedConstructs: [{ vhSeqId: 1, vlSeqId: 2, species: 'human-like' }],
  expectedCompetitorOverlaps: [{ seqId: 1, competitorAccession: 'PAT_W', level: 'whole' }],
  mustNotAssert: [],
};

const workup = {
  patentNumber: 'US1',
  patent: { input: 'US1', found: true, applicants: ['ACME'], inventors: [], ipc: [], family: ['EP1'] },
  constructs: [{ name: 'Ab1', regions: [
    { regionLabel: 'VH', seqId: 1, residues: 'EVQL' }, { regionLabel: 'VL', seqId: 2, residues: 'DIQM' },
  ], species: { classification: 'human-like', evidence: '' } }],
  ungrouped: [], narrative: { summary: '', points: [] },
  graph: [{ subject: 'SEQ:1', predicate: 'MATCHES', object: 'PAT_W', provenance: 'blast-pataa', confidence: 'verified' }],
} as unknown as PatentWorkup;

describe('scorePatent', () => {
  it('computes every metric from a workup + golden', () => {
    const m = scorePatent(workup, golden);
    expect(m.extractionRecall).toBeCloseTo(0.5);      // seq 1 found of 2 declared
    expect(m.residueFidelity).toBe(1);                 // seq 1 residues match
    expect(m.assigneeRecall).toBe(1);
    expect(m.familyRecall).toBe(1);
    expect(m.speciesAccuracy).toBe(1);
    expect(m.pairingAccuracy).toBe(1);
    expect(m.competitorRecallWhole).toBe(1);
    expect(m.competitorRecallCdr).toBe(1);             // none expected -> 1
    expect(m.competitorPrecisionWhole).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @sonny/eval test -- patentScore`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `eval/src/patentScore.ts`:

```ts
import type { PatentWorkup } from '@mrsirquanzo/sonny-core';
import type { GoldenPatent } from './goldenPatent.js';
import {
  extractionRecall, residueFidelity, setRecall, speciesAccuracy, pairingAccuracy,
  competitorRecall, competitorPrecision,
} from './goldenPatent.js';
import { gotConstructs, gotCompetitorOverlaps } from './patentPipeline.js';

export interface PatentMetrics {
  extractionRecall: number; residueFidelity: number;
  assigneeRecall: number; familyRecall: number;
  speciesAccuracy: number; pairingAccuracy: number;
  competitorRecallWhole: number; competitorRecallCdr: number;
  competitorPrecisionWhole: number; competitorPrecisionCdr: number;
}

export function scorePatent(workup: PatentWorkup, golden: GoldenPatent): PatentMetrics {
  const foundSeqIds = golden.knownSequences.map((k) => k.seqId).filter((id) =>
    workup.constructs.some((c) => c.regions.some((r) => r.seqId === id)));
  const extracted = workup.constructs.flatMap((c) => c.regions.map((r) => ({ seqId: r.seqId, residues: r.residues })));
  const gc = gotConstructs(workup);
  const overlaps = gotCompetitorOverlaps(workup);
  return {
    extractionRecall: extractionRecall(foundSeqIds, golden.declaredSequenceCount),
    residueFidelity: residueFidelity(extracted, golden.knownSequences),
    assigneeRecall: setRecall(workup.patent.applicants ?? [], golden.expectedAssignees),
    familyRecall: setRecall(workup.patent.family ?? [], golden.expectedFamilyMembers),
    speciesAccuracy: speciesAccuracy(gc, golden.expectedConstructs),
    pairingAccuracy: pairingAccuracy(gc, golden.expectedConstructs),
    competitorRecallWhole: competitorRecall(overlaps, golden.expectedCompetitorOverlaps, 'whole'),
    competitorRecallCdr: competitorRecall(overlaps, golden.expectedCompetitorOverlaps, 'cdr'),
    competitorPrecisionWhole: competitorPrecision(overlaps, golden.expectedCompetitorOverlaps, 'whole'),
    competitorPrecisionCdr: competitorPrecision(overlaps, golden.expectedCompetitorOverlaps, 'cdr'),
  };
}
```

Note on `extracted`/`residueFidelity`: the region `residues` are the per-region substrings; the synthetic golden's `knownSequences` use the same values the fixture puts in the regions. If `residueFidelity` needs the full sequence rather than a region substring, the golden's `knownSequences` must store what the workup actually carries (per-region residues). Keep the test's expectation aligned with the fixture.

- [ ] **Step 4: Run to verify pass, then full eval suite**

Run: `pnpm --filter @sonny/eval test -- patentScore` (PASS), then `pnpm --filter @sonny/eval test` (PASS).

- [ ] **Step 5: Commit**

```bash
git add eval/src/patentScore.ts eval/src/patentScore.test.ts
git commit -m "feat(eval): scorePatent metrics roll-up for a workup vs golden"
```

---

### Task 4: Wire `matchCdrCompetitors` into the offline pipeline (closes H4 minor)

**Files:**
- Modify: `eval/src/patentPipeline.ts`
- Test: `eval/src/patentPipeline.test.ts`

**Interfaces:**
- Consumes: `matchCdrCompetitors`, `CdrBlast` from `@mrsirquanzo/sonny-core`.
- Produces: `runPatentPipeline` deps gain optional `cdrBlast?: CdrBlast`; the graph now carries cdr-level edges when a cdr hit is returned.

- [ ] **Step 1: Write the failing test**

Append to `eval/src/patentPipeline.test.ts` (reuse the file's existing model/deps mock style; adapt names to what is already there):

```ts
import { runPatentPipeline, gotCompetitorOverlaps } from './patentPipeline.js';
import type { CdrBlast } from '@mrsirquanzo/sonny-core';

describe('runPatentPipeline cdr competitor overlap', () => {
  it('scores a cdr-level overlap when cdrBlast returns a >=90% pataa hit', async () => {
    const model = { async generateStructured(opts: { system: string }) {
      if (opts.system.includes('extract')) return { associations: [{ regionLabel: 'VH', seqId: 1 }] } as never;
      if (opts.system.includes('group')) return { constructs: [{ name: 'Ab1', members: [{ regionLabel: 'VH', seqId: 1 }] }] } as never;
      return { summary: 'ACME.', points: [] } as never;
    } };
    const cdrBlast: CdrBlast = async () => [
      { id: 'x', kind: 'patent', source: 'b', title: 't', snippet: '', url: '', retrievedAt: '', raw: { accession: 'PAT_CDR', percentIdentity: 100, queryCoverage: 100, identity: 12, alignLen: 12, organism: '' } } as never,
    ];
    const md = 'Patent US 10,123,456 B2\nClaims\nSEQ ID NO: 1\nEVQLVESGGGLVQPGGSLRLSCAASGFTFSSYAMSWVRQAPGKGLEWVS\n';
    const workup = await runPatentPipeline(md, {
      model,
      reconcileDeps: {
        blast: async () => [],
        anarci: async () => ({ overallStatus: 'confirmed', domains: [{ chain: 'H', species: 'homo_sapiens', germline: { v: '', j: '' }, numberedRegions: { 'CDR-H3': { seq: 'ARDYYGSSYFDY', imgtStart: 105, imgtEnd: 117, residues: [] } } }], regionChecks: [], speciesSummary: [] }),
        epo: async () => ({ input: 'US10123456', found: true, applicants: ['ACME'], inventors: [], ipc: [], family: [] }),
      },
      cdrBlast,
    });
    expect(gotCompetitorOverlaps(workup)).toContainEqual({ seqId: 1, competitorAccession: 'PAT_CDR', level: 'cdr' });
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @sonny/eval test -- patentPipeline`
Expected: FAIL (no cdr edge; `cdrBlast` not consumed).

- [ ] **Step 3: Implement**

In `eval/src/patentPipeline.ts`:

Extend the imports:

```ts
import {
  extractPatentData, reconcilePatent, groupConstructs, buildWorkup, synthesizeCompetitiveIP, graphRelationships, matchCdrCompetitors,
} from '@mrsirquanzo/sonny-core';
import type { StructuredModel, ReconcileDeps, PatentWorkup, CdrBlast } from '@mrsirquanzo/sonny-core';
```

Change the `deps` type and body of `runPatentPipeline`:

```ts
export async function runPatentPipeline(
  markdown: string,
  deps: { model: StructuredModel; reconcileDeps?: ReconcileDeps; cdrBlast?: CdrBlast },
): Promise<PatentWorkup> {
  const extracted = await extractPatentData(markdown, deps.model);
  const reconciliation = await reconcilePatent(extracted, deps.reconcileDeps);
  const constructs = await groupConstructs(markdown, extracted.associations, deps.model);
  const workup = buildWorkup(extracted, reconciliation, constructs);
  workup.narrative = await synthesizeCompetitiveIP(workup, deps.model);
  if (deps.cdrBlast) await matchCdrCompetitors(workup, reconciliation, deps.cdrBlast);
  workup.graph = graphRelationships(workup);
  return workup;
}
```

(Leave `gotConstructs` / `gotCompetitorOverlaps` unchanged.)

- [ ] **Step 4: Run to verify pass, then full eval suite**

Run: `pnpm --filter @sonny/eval test -- patentPipeline` (PASS), then `pnpm --filter @sonny/eval test` (PASS).

- [ ] **Step 5: Commit**

```bash
git add eval/src/patentPipeline.ts eval/src/patentPipeline.test.ts
git commit -m "feat(eval): wire matchCdrCompetitors into the offline pipeline so cdr overlap is scored"
```

---

### Task 5: `patentLive.ts` runner + `patentLiveMain.ts` CLI + skip-gated test

**Files:**
- Create: `eval/src/patentLive.ts`
- Create: `eval/src/patentLiveMain.ts`
- Test: `eval/src/patentLive.test.ts`

**Interfaces:**
- Consumes: `ingestToMarkdown`, `blastVerifyTool` from `@mrsirquanzo/sonny-mcp-gateway`; core pipeline fns + `AnthropicModel`, `makeDecorrelatedVerifier`, `verifyNarrative`, `matchCdrCompetitors`; `detectLiveCapabilities`, `liveEnabled`, `loadGoldens`, `scorePatent`.
- Produces: `LiveRunReport`, `runLivePatent(golden, patentFile, caps)`.

- [ ] **Step 1: Write the failing test**

Create `eval/src/patentLive.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { detectLiveCapabilities, liveEnabled } from './liveGate.js';

const caps = detectLiveCapabilities();

describe('patentLive (opt-in)', () => {
  it.skipIf(!liveEnabled(caps))('runs the live pipeline over verified goldens and meets thresholds', async () => {
    const { runLivePatent } = await import('./patentLive.js');
    const { loadGoldens } = await import('./goldenLoader.js');
    const verified = loadGoldens().filter((l) => l.groundTruthVerified);
    for (const l of verified) {
      const file = process.env[`SONNY_GOLDEN_FILE_${l.golden.name}`];
      if (!file) continue;
      const report = await runLivePatent(l.golden, file, caps);
      expect(report.metrics.residueFidelity).toBeGreaterThanOrEqual(0.99);
      expect(report.metrics.extractionRecall).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('module exports runLivePatent and it never asserts on its own', async () => {
    const mod = await import('./patentLive.js');
    expect(typeof mod.runLivePatent).toBe('function');
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @sonny/eval test -- patentLive`
Expected: FAIL (module not found) on the second (always-run) test.

- [ ] **Step 3: Implement the runner**

Create `eval/src/patentLive.ts`:

```ts
import { ingestToMarkdown, blastVerifyTool } from '@mrsirquanzo/sonny-mcp-gateway';
import {
  extractPatentData, reconcilePatent, groupConstructs, buildWorkup, synthesizeCompetitiveIP,
  graphRelationships, matchCdrCompetitors, AnthropicModel, makeDecorrelatedVerifier, verifyNarrative,
} from '@mrsirquanzo/sonny-core';
import type { PatentWorkup } from '@mrsirquanzo/sonny-core';
import type { GoldenPatent } from './goldenPatent.js';
import { scorePatent, type PatentMetrics } from './patentScore.js';
import type { LiveCapabilities } from './liveGate.js';

export interface LiveRunReport {
  name: string;
  groundTruthVerified: boolean;
  metrics: PatentMetrics;
  capabilities: LiveCapabilities;
  notes: string[];
}

// Composes the real pipeline inside eval (eval cannot import apps/cli). Tool deps default to the real
// tools inside reconcilePatent, which soft-degrade on their own (EPO_CONFIG_MISSING / anarci_unavailable).
export async function runLivePatent(golden: GoldenPatent, patentFile: string, caps: LiveCapabilities): Promise<LiveRunReport> {
  const notes: string[] = [];
  const res = await ingestToMarkdown(patentFile);
  if (res.status !== 'ok') throw new Error(`ingest failed for ${patentFile}: ${res.error ?? 'unknown'}`);
  const model = new AnthropicModel();
  const extracted = await extractPatentData(res.markdown, model);
  const reconciliation = await reconcilePatent(extracted);  // real blast/anarci/epo defaults
  const constructs = await groupConstructs(res.markdown, extracted.associations, model);
  const workup: PatentWorkup = buildWorkup(extracted, reconciliation, constructs);
  workup.narrative = await synthesizeCompetitiveIP(workup, model);
  workup.narrative = await verifyNarrative(workup.narrative, workup, makeDecorrelatedVerifier());
  const cdrBlast = (seq: string, db: string, opts?: { wordSize?: number; matrix?: string; expect?: number }) =>
    blastVerifyTool.call({ sequence: seq, database: db, ...opts });
  await matchCdrCompetitors(workup, reconciliation, cdrBlast);
  workup.graph = graphRelationships(workup);
  if (!caps.epo) notes.push('EPO disabled: patent identity/family/legal not verified this run');
  if (!caps.anarci) notes.push('ANARCI disabled: region/species confirmation degraded');
  return { name: golden.name, groundTruthVerified: golden.groundTruthVerified === true, metrics: scorePatent(workup, golden), capabilities: caps, notes };
}
```

- [ ] **Step 4: Implement the CLI**

Create `eval/src/patentLiveMain.ts`:

```ts
// Opt-in live patent eval. Usage:
//   SONNY_LIVE=1 ANTHROPIC_API_KEY=... [SONNY_EPO_KEY=... SONNY_EPO_SECRET=... SONNY_ANARCI=1] \
//   SONNY_GOLDEN_FILE_<name>=/path/to/patent.pdf pnpm --filter @sonny/eval exec tsx src/patentLiveMain.ts
import { detectLiveCapabilities, liveEnabled } from './liveGate.js';
import { loadGoldens } from './goldenLoader.js';
import { runLivePatent } from './patentLive.js';

const caps = detectLiveCapabilities();
console.log('live capabilities:', JSON.stringify({ live: caps.live, anthropic: caps.anthropic, epo: caps.epo, anarci: caps.anarci }));
for (const r of caps.reasons) console.log('  -', r);
if (!liveEnabled(caps)) { console.log('live tier not enabled; set SONNY_LIVE=1 and ANTHROPIC_API_KEY.'); process.exit(0); }

for (const l of loadGoldens()) {
  const file = process.env[`SONNY_GOLDEN_FILE_${l.golden.name}`];
  if (!file) { console.log(`skip ${l.golden.name}: no SONNY_GOLDEN_FILE_${l.golden.name}`); continue; }
  const report = await runLivePatent(l.golden, file, caps);
  const label = report.groundTruthVerified ? 'VERIFIED' : 'UNVERIFIED (observe-only)';
  console.log(`\n[${label}] ${report.name}`);
  console.log(JSON.stringify(report.metrics, null, 2));
  for (const n of report.notes) console.log('  note:', n);
}
```

- [ ] **Step 5: Run to verify pass, then full eval suite + build**

Run: `pnpm --filter @sonny/eval test -- patentLive` (PASS: the always-run export test; the live test is skipped).
Then `pnpm --filter @sonny/eval test` (PASS), then `pnpm -r build` (all packages Done - eval uses node builtins, confirm eval declares `@types/node` if tsc flags it; if so add `"@types/node": "^18.19.130"` to `eval/package.json` devDependencies and rerun `pnpm install` + `pnpm -r build`).

- [ ] **Step 6: Commit**

```bash
git add eval/src/patentLive.ts eval/src/patentLiveMain.ts eval/src/patentLive.test.ts eval/package.json pnpm-lock.yaml
git commit -m "feat(eval): opt-in live patent runner + CLI (observe-only for unverified goldens)"
```

---

## Self-review notes

- Every task ends green and independently reviewable.
- Task 5's live test is skip-gated so CI stays inert; the always-run export test guarantees the module compiles and loads.
- Task 4 closes the H4 offline minor (cdr overlap now scored end-to-end offline).
- The `@types/node` note in Task 5 pre-empts the same CI build-gate gap that bit the H4 merge (eval's live runner uses node builtins via mcp-gateway ingest and `process.env`).
