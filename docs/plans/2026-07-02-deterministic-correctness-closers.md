# Deterministic Correctness Closers Implementation Plan (H5 + H2-completeness)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four deterministic, no-LLM, no-external-dependency checks so a dossier surfaces its own gaps: extraction completeness + residue-alphabet validation (extraction), and a construct-pairing sanity gate + non-antibody classification (workup).

**Architecture:** Additive fields on `ExtractedPatent` (`completeness`), `WorkedConstruct` (`pairingWarning`), and `PatentWorkup` (`disclosureShape`), each computed by a deterministic, total function that reads already-assembled data and never throws or drops data.

**Tech Stack:** TypeScript ESM, Vitest. Test runner: `pnpm --filter @sonny/core test`.

**Spec:** [docs/specs/2026-07-02-deterministic-correctness-closers-design.md](../specs/2026-07-02-deterministic-correctness-closers-design.md).

## Global Constraints

- Never use the em dash; use a plain hyphen.
- Never auto-add a commit co-author.
- ESM relative imports use the `.js` extension; all imports at the top.
- Deterministic and total: these checks add findings, they never throw and never drop data.
- Touch only `packages/core/src/patentData.ts` (+ test) and `packages/core/src/patentWorkup.ts` (+ test).

---

### Task 1: Extraction completeness + alphabet validation

**Files:**
- Modify: `packages/core/src/patentData.ts`
- Test: `packages/core/src/patentData.test.ts`

**Interfaces:**
- Produces: `interface ExtractionCompleteness { foundCount, referencedMax, missingSeqIds, alphabetWarnings }`; `ExtractedPatent` gains `completeness: ExtractionCompleteness`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/patentData.test.ts`:

```ts
describe('extraction completeness', () => {
  it('flags referenced-but-unextracted SEQ-IDs and residue-alphabet garbage', async () => {
    const md = [
      'Patent US 10,123,456 B2', 'Claims',
      '1. antibody comprising CDR-H1 of SEQ ID NO: 5.',   // references seq 5, never listed
      '', 'SEQ ID NO: 1', 'EVQLVES', '', 'SEQ ID NO: 2', 'DIQBZOX', '',   // seq 2 has non-residue letters
    ].join('\n');
    // model returns an association referencing SEQ-ID 5 (which has no listed sequence)
    const model = { async generateStructured() { return { associations: [{ regionLabel: 'CDR-H1', seqId: 5 }] } as never; } };
    const data = await extractPatentData(md, model);
    const c = data.completeness!;   // extractPatentData always populates it
    expect(c.foundCount).toBe(2);
    expect(c.referencedMax).toBe(5);
    expect(c.missingSeqIds).toEqual([3, 4, 5]);
    const warn = c.alphabetWarnings.find((w) => w.seqId === 2);
    expect(warn?.invalidChars).toContain('B');
    expect(c.alphabetWarnings.find((w) => w.seqId === 1)).toBeUndefined(); // clean
  });
});
```

(Add `extractPatentData` to the top import if the test file does not already import it.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/core test -- patentData`
Expected: FAIL - `completeness` is undefined.

- [ ] **Step 3: Implement completeness**

In `packages/core/src/patentData.ts`, add the interface (near `ExtractedPatent`) and extend `ExtractedPatent`:

```ts
export interface ExtractionCompleteness {
  foundCount: number;
  referencedMax: number;
  missingSeqIds: number[];
  alphabetWarnings: Array<{ seqId: number; invalidChars: string }>;
}
```

Add to `ExtractedPatent` (optional so hand-built literals elsewhere do not break; `extractPatentData` always populates it):

```ts
  completeness?: ExtractionCompleteness;
```

Add the computation helper (module-level) and call it in `extractPatentData`:

```ts
// Standard 20 amino acids plus U (selenocysteine / RNA) and N (nucleotide ambiguity). ACGT are already AA letters.
const VALID_RESIDUES = new Set('ACDEFGHIKLMNPQRSTVWYUN'.split(''));

function computeCompleteness(
  sequences: Array<{ seqId: number; residues: string }>,
  associations: Array<{ seqId: number }>,
): ExtractionCompleteness {
  const foundIds = new Set(sequences.map((s) => s.seqId));
  const referencedMax = Math.max(0, ...sequences.map((s) => s.seqId), ...associations.map((a) => a.seqId));
  const missingSeqIds: number[] = [];
  for (let i = 1; i <= referencedMax; i++) if (!foundIds.has(i)) missingSeqIds.push(i);
  const alphabetWarnings: Array<{ seqId: number; invalidChars: string }> = [];
  for (const s of sequences) {
    const invalid = [...new Set(s.residues.split(''))].filter((ch) => !VALID_RESIDUES.has(ch));
    if (invalid.length > 0) alphabetWarnings.push({ seqId: s.seqId, invalidChars: invalid.join('') });
  }
  return { foundCount: sequences.length, referencedMax, missingSeqIds, alphabetWarnings };
}
```

Then in `extractPatentData`, before the `return`, compute it and include it:

```ts
  const completeness = computeCompleteness(sequences, associations);
  return {
    patentNumber,
    sequences,
    associations: associations.map((a) => ({ ...a, residues: byId.get(a.seqId) })),
    completeness,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/core test -- patentData`
Expected: PASS.

- [ ] **Step 5: Run the full core suite and commit**

Run: `pnpm --filter @sonny/core test`
Expected: PASS (no regressions; `completeness` is additive).

```bash
git add packages/core/src/patentData.ts packages/core/src/patentData.test.ts
git commit -m "feat(core): add extraction completeness and residue-alphabet validation"
```

---

### Task 2: Construct-pairing sanity gate + non-antibody classification

**Files:**
- Modify: `packages/core/src/patentWorkup.ts`
- Test: `packages/core/src/patentWorkup.test.ts`

**Interfaces:**
- Produces: `WorkedConstruct` gains `pairingWarning?: string`; `PatentWorkup` gains `disclosureShape: 'antibody' | 'not-standard-antibody'`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/patentWorkup.test.ts`:

```ts
describe('pairing gate and non-antibody classification', () => {
  function vh(seqId: number, chain: 'H' | 'K' | 'L') {
    return vseq({ seqId, residues: 'E'.repeat(60), regionLabels: [chain === 'H' ? 'VH' : 'VL'], domain: { chain, species: 'homo_sapiens', numberedRegions: {} } });
  }

  it('sets no pairingWarning for a complementary heavy+light construct and disclosureShape antibody', () => {
    const wk = buildWorkup(extractedP, recon([vh(1, 'H'), vh(2, 'K')]),
      [{ name: 'Ab', members: [{ regionLabel: 'VH', seqId: 1 }, { regionLabel: 'VL', seqId: 2 }] }]);
    expect(wk.constructs[0].pairingWarning).toBeUndefined();
    expect(wk.disclosureShape).toBe('antibody');
  });

  it('flags two heavy chains and a lone heavy chain', () => {
    const twoH = buildWorkup(extractedP, recon([vh(1, 'H'), vh(2, 'H')]),
      [{ name: 'AbHH', members: [{ regionLabel: 'VH', seqId: 1 }, { regionLabel: 'VH', seqId: 2 }] }]);
    expect(twoH.constructs[0].pairingWarning).toBeTruthy();

    const lone = buildWorkup(extractedP, recon([vh(1, 'H')]), [{ name: 'AbH', members: [{ regionLabel: 'VH', seqId: 1 }] }]);
    expect(lone.constructs[0].pairingWarning).toBeTruthy();
  });

  it('classifies a disclosure with no numbered variable domain as not-standard-antibody', () => {
    const noDomain = vseq({ seqId: 1, residues: 'AAAA', regionLabels: ['Fc'] });
    const wk = buildWorkup(extractedP, recon([noDomain]), [{ name: 'X', members: [{ regionLabel: 'Fc', seqId: 1 }] }]);
    expect(wk.disclosureShape).toBe('not-standard-antibody');
  });
});
```

(The `vseq`, `extractedP`, and `recon` helpers already exist in this test file from the buildWorkup tests.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/core test -- patentWorkup`
Expected: FAIL - `pairingWarning` / `disclosureShape` do not exist.

- [ ] **Step 3: Implement the gate and classification**

In `packages/core/src/patentWorkup.ts`:

Add `pairingWarning?: string;` to the `WorkedConstruct` interface, and `disclosureShape?: 'antibody' | 'not-standard-antibody';` to the `PatentWorkup` interface (optional so existing `PatentWorkup` literals in other tests do not break; `buildWorkup` always sets it).

Add a helper (module-level):

```ts
function pairingWarningFor(chains: Array<'H' | 'K' | 'L'>): string | undefined {
  if (chains.length === 0) return undefined; // no numbered domain -> handled by disclosureShape
  const heavy = chains.filter((c) => c === 'H').length;
  const light = chains.filter((c) => c === 'K' || c === 'L').length;
  if (heavy === 1 && light === 1) return undefined;
  if (heavy > 1) return 'two or more heavy chains grouped into one construct';
  if (light > 1) return 'two or more light chains grouped into one construct';
  if (heavy === 1 && light === 0) return 'heavy chain with no paired light chain';
  if (light === 1 && heavy === 0) return 'light chain with no paired heavy chain';
  return undefined;
}
```

In `buildWorkup`, inside the per-construct map (where `vhSeq`/`vlSeq` are resolved), collect the numbered-domain chains for the construct's members and set `pairingWarning`:

```ts
    const chains = c.members
      .map((m) => bySeq.get(m.seqId)?.domain?.chain)
      .filter((ch): ch is 'H' | 'K' | 'L' => ch !== undefined);
    const pairingWarning = pairingWarningFor(chains);
```

and include `pairingWarning` in the returned `WorkedConstruct`:

```ts
    return { name: c.name, regions, species, pairingWarning };
```

After the `workedConstructs` are built, compute `disclosureShape` and include it in the returned `PatentWorkup`:

```ts
  const anyDomain = constructs.some((c) => c.members.some((m) => bySeq.get(m.seqId)?.domain !== undefined));
  const disclosureShape: PatentWorkup['disclosureShape'] = anyDomain ? 'antibody' : 'not-standard-antibody';
```

Add `disclosureShape` to the returned object (alongside `patentNumber`, `patent`, `constructs`, `ungrouped`, `narrative`, `graph`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/core test -- patentWorkup`
Expected: PASS.

- [ ] **Step 5: Run the full core suite and commit**

Run: `pnpm --filter @sonny/core test`
Expected: PASS.

```bash
git add packages/core/src/patentWorkup.ts packages/core/src/patentWorkup.test.ts
git commit -m "feat(core): add construct-pairing sanity gate and non-antibody classification"
```

---

## Notes for the controller

- The new fields are optional on the types (so hand-built literals in other test files do not break) but are ALWAYS populated by the real functions (`extractPatentData`, `buildWorkup`). Consumers of the real functions can rely on them.
- Out of scope (later H2-design slice): the `exactMatch` full-length guard and ST.26 XML parsing (need declared per-sequence length).
