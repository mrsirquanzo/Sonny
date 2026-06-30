# Phase 3: KOL & Specialty Lab Mapping - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the human terrain - the principal investigators and specialty labs driving the target's literature - as a pure, grounded aggregation over the evidence store, and surface it in the dossier.

**Architecture:** `Evidence.metadata` (authors/institutions) populated by the Europe PMC tool; a `KOLCluster` contract; a pure `mapSpecialtyLabs(store, target)` (last-author = PI, full-text papers weighted higher); wired into `runDeepResearch` and the briefing, rendered in the CLI and streamed as a trace event.

**Tech Stack:** TypeScript ESM, Vitest, Zod. Test runners: `pnpm --filter @sonny/shared test`, `pnpm --filter @sonny/mcp-gateway test`, `pnpm --filter @sonny/core test`, `pnpm --filter @sonny/cli test`.

## Global Constraints

- Never use the em dash; use a plain hyphen.
- Never auto-add a commit co-author.
- ESM relative imports use the `.js` extension.
- Structured output only (Zod); `mapSpecialtyLabs` validates its result with `KOLClusterSchema.parse`.
- KOL mapping is a pure function over the store - no model call. Every lab is grounded in the evidence ids it was derived from (no token, no ship).
- PI = the last author; full-text deep-read papers weigh `3`, abstract-only hits weigh `1` (down-weighted, not ignored).

---

### Task 1: Contracts (`@sonny/shared`)

**Files:**
- Modify: `packages/shared/src/contracts.ts`
- Test: `packages/shared/src/contracts.test.ts`

**Interfaces:**
- Produces: `AuthorSchema`/`Author`, `EvidenceMetadataSchema`/`EvidenceMetadata`, `EvidenceSchema.metadata?`; `SpecialtyLabSchema`, `KOLClusterSchema`/`KOLCluster`; a `kol_cluster` TraceEvent variant; `Briefing.kolCluster?`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/contracts.test.ts`:

```ts
import { EvidenceMetadataSchema, KOLClusterSchema, EvidenceSchema } from './contracts.js';

describe('Evidence metadata and KOLCluster schemas', () => {
  it('Evidence accepts optional metadata with authors and institutions', () => {
    const e = { id: 'PMID:1', kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now',
      metadata: { authors: [{ name: 'Smith J', affiliation: 'MIT', orcid: '0000-0001' }], institutions: ['MIT'] } };
    expect(EvidenceSchema.parse(e).metadata?.authors?.[0].name).toBe('Smith J');
  });

  it('Evidence is valid without metadata', () => {
    expect(EvidenceSchema.parse({ id: 'PMID:1', kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' }).metadata).toBeUndefined();
  });

  it('an author requires a name', () => {
    expect(() => EvidenceMetadataSchema.parse({ authors: [{ affiliation: 'x' }] })).toThrow();
  });

  it('KOLCluster validates labs', () => {
    const c = { target: 'CDCP1', labs: [{ investigator: 'Smith J', institution: 'MIT', paperCount: 3, weight: 9, evidenceIds: ['PMID:1'] }] };
    expect(KOLClusterSchema.parse(c).labs[0].investigator).toBe('Smith J');
  });

  it('KOLCluster rejects a non-integer paperCount', () => {
    expect(() => KOLClusterSchema.parse({ target: 't', labs: [{ investigator: 'x', paperCount: 1.5, weight: 1, evidenceIds: [] }] })).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/shared test -- contracts`
Expected: FAIL - the schemas do not exist.

- [ ] **Step 3: Add the schemas**

In `packages/shared/src/contracts.ts`:

Add the metadata schemas BEFORE `EvidenceSchema` (which will reference them):

```ts
export const AuthorSchema = z.object({
  name: z.string().min(1),
  affiliation: z.string().optional(),
  orcid: z.string().optional(),
});
export type Author = z.infer<typeof AuthorSchema>;

export const EvidenceMetadataSchema = z.object({
  authors: z.array(AuthorSchema).optional(),
  institutions: z.array(z.string()).optional(),
});
export type EvidenceMetadata = z.infer<typeof EvidenceMetadataSchema>;
```

Add `metadata` to `EvidenceSchema`:

```ts
  metadata: EvidenceMetadataSchema.optional(),
```

Add the KOL schemas BEFORE the `TraceEvent` union and the `Briefing` interface (which reference `KOLCluster`):

```ts
export const SpecialtyLabSchema = z.object({
  investigator: z.string().min(1),
  institution: z.string().optional(),
  paperCount: z.number().int().nonnegative(),
  weight: z.number(),
  evidenceIds: z.array(z.string()),
});
export type SpecialtyLab = z.infer<typeof SpecialtyLabSchema>;

export const KOLClusterSchema = z.object({
  target: z.string(),
  labs: z.array(SpecialtyLabSchema),
});
export type KOLCluster = z.infer<typeof KOLClusterSchema>;
```

Add the trace-event variant to the `TraceEvent` union:

```ts
  | { type: 'kol_cluster'; cluster: KOLCluster }
```

Add `kolCluster` to the `Briefing` interface:

```ts
  kolCluster?: KOLCluster;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/shared test`
Expected: PASS - all shared tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/contracts.ts packages/shared/src/contracts.test.ts
git commit -m "feat(shared): Evidence author metadata and KOLCluster contracts"
```

---

### Task 2: Europe PMC tool captures author metadata

**Files:**
- Modify: `packages/mcp-gateway/src/europePmc.ts`
- Test: `packages/mcp-gateway/src/europePmc.test.ts`

- [ ] **Step 1: Update the failing test**

In `packages/mcp-gateway/src/europePmc.test.ts`, add an `authorList` to the FIRST hit in the existing `payload` (alongside its other fields):

```ts
    authorList: { author: [
      { fullName: 'Smith J', authorId: { type: 'ORCID', value: '0000-0002-1234-5678' },
        authorAffiliationDetailsList: { authorAffiliation: [{ affiliation: 'MIT, Cambridge, USA' }] } },
      { fullName: 'Doe A',
        authorAffiliationDetailsList: { authorAffiliation: [{ affiliation: 'MIT, Cambridge, USA' }] } },
    ] },
```

Append a test:

```ts
  it('captures author metadata (names, affiliations, ORCID) when present', async () => {
    const out = await europePmcSearchTool.call({ query: 'CDCP1 cancer' }, fakeFetch);
    expect(out[0].metadata?.authors?.map((a) => a.name)).toEqual(['Smith J', 'Doe A']);
    expect(out[0].metadata?.authors?.[0].affiliation).toBe('MIT, Cambridge, USA');
    expect(out[0].metadata?.authors?.[0].orcid).toBe('0000-0002-1234-5678');
    expect(out[0].metadata?.institutions).toEqual(['MIT, Cambridge, USA']);
    expect(out[1].metadata).toBeUndefined(); // second hit has no authorList
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @sonny/mcp-gateway test -- europePmc`
Expected: FAIL - `metadata` is not populated.

- [ ] **Step 3: Parse author metadata**

In `packages/mcp-gateway/src/europePmc.ts`:

1. Import the metadata type:

```ts
import type { Evidence, EvidenceMetadata } from '@sonny/shared';
```

2. Extend the `Hit` interface with the author shape:

```ts
interface Hit {
  id: string; source: string; pmid?: string; pmcid?: string;
  title?: string; abstractText?: string; citedByCount?: string;
  isOpenAccess?: string; firstPublicationDate?: string;
  pubTypeList?: { pubType?: string[] };
  authorList?: { author?: Array<{
    fullName?: string;
    authorId?: { type?: string; value?: string };
    authorAffiliationDetailsList?: { authorAffiliation?: Array<{ affiliation?: string }> };
  }> };
}
```

3. Add a parser above the tool:

```ts
function parseMetadata(h: Hit): EvidenceMetadata | undefined {
  const list = h.authorList?.author ?? [];
  if (!list.length) return undefined;
  const authors = list.map((a) => {
    const affiliation = a.authorAffiliationDetailsList?.authorAffiliation?.[0]?.affiliation;
    const orcid = a.authorId?.type === 'ORCID' ? a.authorId.value : undefined;
    return { name: a.fullName ?? '(unknown)', ...(affiliation ? { affiliation } : {}), ...(orcid ? { orcid } : {}) };
  });
  const institutions = [...new Set(authors.map((a) => a.affiliation).filter((x): x is string => !!x))];
  return { authors, ...(institutions.length ? { institutions } : {}) };
}
```

4. In the `.map<Evidence>(...)` body, compute and conditionally attach the metadata:

```ts
        const metadata = parseMetadata(h);
        return {
          id: `PMID:${h.pmid}`, kind: 'publication', source: 'Europe PMC',
          title: h.title ?? '(no title)',
          snippet: `cited ${h.citedByCount ?? '0'}x . ${h.firstPublicationDate ?? ''}`.trim(),
          passage: h.abstractText ?? '',
          url: `https://europepmc.org/article/${h.source}/${h.pmid}`,
          raw: { pmcid: h.pmcid ?? '', citedByCount: Number(h.citedByCount ?? 0), isReview, isOpenAccess: h.isOpenAccess === 'Y' },
          retrievedAt: now,
          ...(metadata ? { metadata } : {}),
        };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @sonny/mcp-gateway test -- europePmc`
Expected: PASS - metadata captured; the metadata-less hit has no metadata.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-gateway/src/europePmc.ts packages/mcp-gateway/src/europePmc.test.ts
git commit -m "feat(mcp-gateway): capture author names, affiliations, and ORCID into Evidence metadata"
```

---

### Task 3: KOL detector (`kolDetector.ts`)

**Files:**
- Create: `packages/core/src/kolDetector.ts`
- Test: `packages/core/src/kolDetector.test.ts`

**Interfaces:**
- Produces: `mapSpecialtyLabs(store: EvidenceStore, target: string): KOLCluster`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/kolDetector.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Evidence } from '@sonny/shared';
import { EvidenceStore } from './evidenceStore.js';
import { mapSpecialtyLabs } from './kolDetector.js';

function paper(id: string, pi: string, pmcid: string, affiliation?: string): Evidence {
  return { id, kind: 'publication', source: 'Europe PMC', title: id, snippet: '', passage: 'a', url: 'u',
    raw: { pmcid }, retrievedAt: 'now',
    metadata: { authors: [{ name: 'First A' }, { name: pi, ...(affiliation ? { affiliation } : {}) }] } };
}
function fullTextSection(pmcid: string): Evidence {
  return { id: `PMCID:${pmcid}#sec-0`, kind: 'publication', source: 'PMC full text', title: 's', snippet: '', passage: 'x', url: 'u',
    raw: { pmcid }, retrievedAt: 'now' };
}

describe('mapSpecialtyLabs', () => {
  it('ranks the top 3 PIs by weighted last-authorship, weighting full-text over abstract-only', () => {
    const store = new EvidenceStore();
    // Senior B: 3 full-text papers -> weight 9
    for (let i = 0; i < 3; i++) { store.register(paper(`PMID:b${i}`, 'Senior B', `PMCb${i}`, 'Karolinska Institute')); store.register(fullTextSection(`PMCb${i}`)); }
    // Senior A: 2 full-text + 2 abstract -> weight 8
    for (let i = 0; i < 2; i++) { store.register(paper(`PMID:a${i}`, 'Senior A', `PMCa${i}`)); store.register(fullTextSection(`PMCa${i}`)); }
    for (let i = 2; i < 4; i++) store.register(paper(`PMID:a${i}`, 'Senior A', ''));
    // Senior C: 5 abstract-only -> weight 5 (more papers than B, but lower weight)
    for (let i = 0; i < 5; i++) store.register(paper(`PMID:c${i}`, 'Senior C', ''));
    // Senior D: 1 abstract -> weight 1 (outside top 3)
    store.register(paper('PMID:d0', 'Senior D', ''));

    const cluster = mapSpecialtyLabs(store, 'CDCP1');
    expect(cluster.target).toBe('CDCP1');
    expect(cluster.labs.map((l) => l.investigator)).toEqual(['Senior B', 'Senior A', 'Senior C']);
    expect(cluster.labs[0].weight).toBe(9);
    expect(cluster.labs[0].paperCount).toBe(3);
    expect(cluster.labs[0].institution).toBe('Karolinska Institute');
    expect(cluster.labs[0].evidenceIds).toEqual(['PMID:b0', 'PMID:b1', 'PMID:b2']); // grounded
    // full-text seminal (B, 3 papers) outranks abstract-only (C, 5 papers)
    expect(cluster.labs[0].weight).toBeGreaterThan(cluster.labs[2].weight);
  });

  it('returns an empty lab list when no evidence carries author metadata', () => {
    const store = new EvidenceStore();
    store.register({ id: 'ENSG1', kind: 'target', source: 'Open Targets', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' });
    expect(mapSpecialtyLabs(store, 'CDCP1')).toEqual({ target: 'CDCP1', labs: [] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @sonny/core test -- kolDetector`
Expected: FAIL - `mapSpecialtyLabs` does not exist.

- [ ] **Step 3: Implement the detector**

Create `packages/core/src/kolDetector.ts`:

```ts
import { KOLClusterSchema, type KOLCluster } from '@sonny/shared';
import type { EvidenceStore } from './evidenceStore.js';

const FULLTEXT_WEIGHT = 3;
const ABSTRACT_WEIGHT = 1;

function mode(xs: string[]): string {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

// Pure aggregation over the store: the last author is the PI; a paper Sonny deep-read
// (its pmcid has full-text sections in the store) is a seminal paper and weighs more
// than an abstract-only hit. Every lab is grounded in the evidence ids it came from.
export function mapSpecialtyLabs(store: EvidenceStore, target: string): KOLCluster {
  const all = store.all();
  const fullTextPmcids = new Set<string>();
  for (const e of all) {
    if (e.id.startsWith('PMCID:')) {
      const pmcid = (e.raw as { pmcid?: string })?.pmcid;
      if (pmcid) fullTextPmcids.add(pmcid);
    }
  }

  type Agg = { weight: number; paperCount: number; evidenceIds: string[]; affiliations: string[] };
  const byPI = new Map<string, Agg>();

  for (const e of all) {
    const authors = e.metadata?.authors;
    if (!authors || !authors.length) continue;
    const last = authors[authors.length - 1];
    const pmcid = (e.raw as { pmcid?: string })?.pmcid ?? '';
    const w = pmcid && fullTextPmcids.has(pmcid) ? FULLTEXT_WEIGHT : ABSTRACT_WEIGHT;
    const agg = byPI.get(last.name) ?? { weight: 0, paperCount: 0, evidenceIds: [], affiliations: [] };
    agg.weight += w;
    agg.paperCount += 1;
    agg.evidenceIds.push(e.id);
    if (last.affiliation) agg.affiliations.push(last.affiliation);
    byPI.set(last.name, agg);
  }

  const labs = [...byPI.entries()]
    .map(([investigator, a]) => ({
      investigator,
      ...(a.affiliations.length ? { institution: mode(a.affiliations) } : {}),
      paperCount: a.paperCount,
      weight: a.weight,
      evidenceIds: a.evidenceIds,
    }))
    .sort((x, y) => y.weight - x.weight || y.paperCount - x.paperCount || x.investigator.localeCompare(y.investigator))
    .slice(0, 3);

  return KOLClusterSchema.parse({ target, labs });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @sonny/core test -- kolDetector`
Expected: PASS - both cases green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/kolDetector.ts packages/core/src/kolDetector.test.ts
git commit -m "feat(core): mapSpecialtyLabs - grounded KOL and specialty-lab detection"
```

---

### Task 4: Wire into orchestration, briefing, and CLI

**Files:**
- Modify: `packages/core/src/runDeepResearch.ts`
- Modify: `packages/core/src/briefing.ts`
- Modify: `apps/cli/src/deep.ts`
- Modify: `apps/cli/src/run.ts` (formatTrace)

**Interfaces:**
- `DeepResearchResult` gains `kolCluster: KOLCluster`. `Briefing.kolCluster` (added in Task 1) is set from it.

- [ ] **Step 1: Wire `runDeepResearch`**

In `packages/core/src/runDeepResearch.ts`:

1. Add imports:

```ts
import type { KOLCluster } from '@sonny/shared';
import { mapSpecialtyLabs } from './kolDetector.js';
```

2. Add `kolCluster` to the `DeepResearchResult` interface:

```ts
  kolCluster: KOLCluster;
```

3. After the developability block and before the weighing block, compute the cluster:

```ts
  let kolCluster: KOLCluster = { target, labs: [] };
  try {
    kolCluster = mapSpecialtyLabs(store, target);
    emit({ type: 'kol_cluster', cluster: kolCluster });
  } catch (err) {
    emit({ type: 'error', message: `kol mapping failed: ${String(err)}` });
  }
```

4. Add `kolCluster` to the returned object:

```ts
  return { target, sections: finalSections, weighing, evidence: store.all(), kolCluster };
```

- [ ] **Step 2: Carry it onto the Briefing**

In `packages/core/src/briefing.ts`, add `kolCluster` to the returned `Briefing`:

```ts
  return {
    target: result.target, recommendation, executiveRead,
    sections: result.sections, weighing: result.weighing, references: assembleReferences(result),
    kolCluster: result.kolCluster,
  };
```

- [ ] **Step 3: Render in the CLI**

In `apps/cli/src/deep.ts`, after the references block, add:

```ts
  if (briefing.kolCluster && briefing.kolCluster.labs.length) {
    process.stdout.write(`\nKOL & INSTITUTIONAL TERRAIN\n`);
    for (const lab of briefing.kolCluster.labs) {
      process.stdout.write(`  ${lab.investigator}${lab.institution ? ` - ${lab.institution}` : ''}  (${lab.paperCount} papers)\n`);
    }
  }
```

In `apps/cli/src/run.ts` `formatTrace`, add a case before `default`:

```ts
      case 'kol_cluster':
        return `\nLEAD  KOL terrain: ` + (e.cluster.labs.length ? e.cluster.labs.map((l) => l.investigator).join(', ') : 'no dominant labs');
```

- [ ] **Step 4: Run the suites**

Run: `pnpm --filter @sonny/core test && pnpm --filter @sonny/cli test`
Expected: PASS - core green (existing runDeepResearch tests carry an empty `kolCluster` since their fixtures have no author metadata, and the new `kol_cluster` event does not break event assertions); CLI green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runDeepResearch.ts packages/core/src/briefing.ts apps/cli/src/deep.ts apps/cli/src/run.ts
git commit -m "feat(core): map specialty labs post-specialist and surface KOL terrain in the briefing"
```

---

## Notes for the controller

- After all tasks, run `pnpm -r test` before the whole-branch review.
- A free local smoke (`SONNY_BACKEND=ollama pnpm --filter @sonny/cli exec tsx src/index.ts deep CDCP1`) should show a `KOL & INSTITUTIONAL TERRAIN` section naming recurring CDCP1 senior authors and a `LEAD KOL terrain:` trace line.
- Out of scope: institution name normalization, author disambiguation, citation-count weighting beyond the full-text/abstract distinction.
