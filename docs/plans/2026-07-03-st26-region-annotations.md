# ST.26 Region-Annotation Associations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Derive region-to-SEQ-ID associations from ST.26 `INSDFeature` annotations so ST.26 patents get grounded (non-LLM) region labels and assemblable constructs.

**Architecture:** A pure `normalizeRegionNote` maps a feature note to a `RegionLabel`; `extractST26Associations` parses ST.26 features and emits whole-sequence associations; `extractPatentData` uses the structured path for ST.26 input and the LLM path for text.

**Tech Stack:** TypeScript ESM, Vitest, pnpm workspaces, fast-xml-parser (existing).

## Global Constraints

- No em dashes; plain dash. No commit co-author trailer. ESM `.js` imports.
- Pure/never-throw: `normalizeRegionNote` returns `undefined` on no confident match; `extractST26Associations` returns `[]` on malformed XML.
- Confident matches only - never guess a region label from an ambiguous note.
- Whole-sequence rule: a feature yields an association only when its location spans the full sequence (`start<=1 && end>=declaredLength`, declaredLength known); sub-span features are skipped.
- For ST.26 input, structured associations REPLACE the LLM path; text patents are unchanged.
- `RegionLabel` is imported from `@mrsirquanzo/sonny-mcp-gateway` (defined in `anarci.ts`).
- Run `pnpm -r build` (real tsc) before finishing each task.

---

### Task 1: `normalizeRegionNote`

**Files:**
- Modify: `packages/mcp-gateway/src/patentExtract.ts`
- Test: `packages/mcp-gateway/src/patentExtract.test.ts`

**Interfaces:**
- Consumes: `RegionLabel` from `./anarci.js`.
- Produces: `normalizeRegionNote(note: string): RegionLabel | undefined`.

- [ ] **Step 1: Write the failing test**

Append to `packages/mcp-gateway/src/patentExtract.test.ts`:

```ts
import { normalizeRegionNote } from './patentExtract.js';

describe('normalizeRegionNote', () => {
  it('maps confident CDR notes with chain + number', () => {
    expect(normalizeRegionNote('CDR-H3')).toBe('CDR-H3');
    expect(normalizeRegionNote('HCDR3')).toBe('CDR-H3');
    expect(normalizeRegionNote('heavy chain CDR 1')).toBe('CDR-H1');
    expect(normalizeRegionNote('CDR-L2')).toBe('CDR-L2');
  });
  it('maps variable domains and full chains', () => {
    expect(normalizeRegionNote('VH')).toBe('VH');
    expect(normalizeRegionNote('heavy chain variable region')).toBe('VH');
    expect(normalizeRegionNote('variable light')).toBe('VL');
    expect(normalizeRegionNote('heavy chain')).toBe('heavy-chain');
    expect(normalizeRegionNote('light chain')).toBe('light-chain');
    expect(normalizeRegionNote('Fc region')).toBe('Fc');
    expect(normalizeRegionNote('hinge')).toBe('hinge');
  });
  it('returns undefined for unknown or chain-ambiguous notes', () => {
    expect(normalizeRegionNote('signal peptide')).toBeUndefined();
    expect(normalizeRegionNote('linker')).toBeUndefined();
    expect(normalizeRegionNote('CDR 3')).toBeUndefined(); // no chain -> ambiguous
    expect(normalizeRegionNote('')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @mrsirquanzo/sonny-mcp-gateway test -- patentExtract`
Expected: FAIL (not exported).

- [ ] **Step 3: Implement**

Add to `packages/mcp-gateway/src/patentExtract.ts` (import `RegionLabel` at the top: `import type { RegionLabel } from './anarci.js';`):

```ts
export function normalizeRegionNote(note: string): RegionLabel | undefined {
  const n = note.toLowerCase();
  const heavy = /heavy|\bhc\b|\bvh\b|hcdr|\bh[- ]?cdr|\bfr[- ]?h/.test(n);
  const light = /light|\blc\b|\bvl\b|lcdr|\bl[- ]?cdr|\bfr[- ]?l|kappa|lambda/.test(n);
  const cdr = n.match(/cdr[- ]?[hl]?[- ]?([123])\b/) ?? n.match(/[hl]cdr[- ]?([123])\b/) ?? n.match(/cdr\D*?([123])\b/);
  if (/cdr/.test(n) && cdr) {
    const num = cdr[1];
    const chainLetter = n.match(/([hl])[- ]?cdr/) ?? n.match(/cdr[- ]?([hl])\b/);
    const isH = heavy || chainLetter?.[1] === 'h';
    const isL = light || chainLetter?.[1] === 'l';
    if (isH && !isL) return `CDR-H${num}` as RegionLabel;
    if (isL && !isH) return `CDR-L${num}` as RegionLabel;
    return undefined;
  }
  if (/variable|\bvh\b|\bvl\b|\bfv\b/.test(n)) {
    if (heavy && !light) return 'VH';
    if (light && !heavy) return 'VL';
    return undefined;
  }
  if (/\bfab\b/.test(n)) return 'Fab';
  if (/\bfc\b/.test(n)) return 'Fc';
  if (/\bch1\b/.test(n)) return 'CH1';
  if (/\bcl\b|constant light/.test(n)) return 'CL';
  if (/hinge/.test(n)) return 'hinge';
  if (/chain/.test(n)) {
    if (heavy && !light) return 'heavy-chain';
    if (light && !heavy) return 'light-chain';
  }
  return undefined;
}
```

- [ ] **Step 4: Run to verify pass, then full gateway suite + build**

Run: `pnpm --filter @mrsirquanzo/sonny-mcp-gateway test -- patentExtract` (PASS), then `pnpm --filter @mrsirquanzo/sonny-mcp-gateway test` (PASS), then `pnpm -r build` (Done). If a test case does not match the implementation's output, fix the IMPLEMENTATION to satisfy the confident-match intent (do not weaken a correct assertion); if a case is genuinely ambiguous, report it.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-gateway/src/patentExtract.ts packages/mcp-gateway/src/patentExtract.test.ts
git commit -m "feat(mcp-gateway): normalizeRegionNote maps ST.26 feature notes to region labels"
```

---

### Task 2: `extractST26Associations`

**Files:**
- Modify: `packages/mcp-gateway/src/patentExtract.ts`
- Modify: `packages/mcp-gateway/src/index.ts`
- Test: `packages/mcp-gateway/src/patentExtract.test.ts`

**Interfaces:**
- Consumes: `st26Parser`, `asArray`, `normalizeRegionNote`, `RegionLabel`.
- Produces: `extractST26Associations(content: string): Array<{ regionLabel: RegionLabel; seqId: number }>`; exported with `normalizeRegionNote` from index.

- [ ] **Step 1: Write the failing test**

Append to `packages/mcp-gateway/src/patentExtract.test.ts`:

```ts
import { extractST26Associations } from './patentExtract.js';

const ST26_FEAT = `<?xml version="1.0"?>
<ST26SequenceListing>
  <SequenceData sequenceIDNumber="1">
    <INSDSeq><INSDSeq_length>12</INSDSeq_length><INSDSeq_sequence>ARDYYGSSYFDY</INSDSeq_sequence>
      <INSDSeq_feature-table><INSDFeature>
        <INSDFeature_key>REGION</INSDFeature_key><INSDFeature_location>1..12</INSDFeature_location>
        <INSDFeature_quals><INSDQualifier><INSDQualifier_name>note</INSDQualifier_name><INSDQualifier_value>CDR-H3</INSDQualifier_value></INSDQualifier></INSDFeature_quals>
      </INSDFeature></INSDSeq_feature-table>
    </INSDSeq>
  </SequenceData>
  <SequenceData sequenceIDNumber="2">
    <INSDSeq><INSDSeq_length>120</INSDSeq_length><INSDSeq_sequence>${'E'.repeat(120)}</INSDSeq_sequence>
      <INSDSeq_feature-table>
        <INSDFeature><INSDFeature_key>REGION</INSDFeature_key><INSDFeature_location>1..120</INSDFeature_location>
          <INSDFeature_quals><INSDQualifier><INSDQualifier_name>note</INSDQualifier_name><INSDQualifier_value>heavy chain variable region</INSDQualifier_value></INSDQualifier></INSDFeature_quals></INSDFeature>
        <INSDFeature><INSDFeature_key>REGION</INSDFeature_key><INSDFeature_location>99..111</INSDFeature_location>
          <INSDFeature_quals><INSDQualifier><INSDQualifier_name>note</INSDQualifier_name><INSDQualifier_value>CDR-H3</INSDQualifier_value></INSDQualifier></INSDFeature_quals></INSDFeature>
      </INSDSeq_feature-table>
    </INSDSeq>
  </SequenceData>
</ST26SequenceListing>`;

describe('extractST26Associations', () => {
  it('emits whole-sequence associations, skips sub-span features', () => {
    const out = extractST26Associations(ST26_FEAT);
    // SEQ 1: CDR-H3 spans full 12; SEQ 2: VH spans full 120; SEQ 2 sub-span CDR-H3 @ 99..111 skipped
    expect(out).toContainEqual({ regionLabel: 'CDR-H3', seqId: 1 });
    expect(out).toContainEqual({ regionLabel: 'VH', seqId: 2 });
    expect(out).not.toContainEqual({ regionLabel: 'CDR-H3', seqId: 2 });
  });
  it('returns [] on malformed xml and skips unrecognized notes', () => {
    expect(extractST26Associations('<ST26SequenceListing><SequenceData')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @mrsirquanzo/sonny-mcp-gateway test -- patentExtract`
Expected: FAIL (not exported).

- [ ] **Step 3: Implement**

Add to `patentExtract.ts`:

```ts
function locationSpan(loc: unknown): { start: number; end: number } | undefined {
  const nums = String(loc ?? '').match(/\d+/g);
  if (!nums || nums.length === 0) return undefined;
  const ints = nums.map(Number);
  return { start: Math.min(...ints), end: Math.max(...ints) };
}

function noteValue(feature: Record<string, unknown>): string | undefined {
  const quals = (feature['INSDFeature_quals'] ?? {}) as Record<string, unknown>;
  for (const q of asArray(quals['INSDQualifier']) as Array<Record<string, unknown>>) {
    if (String(q['INSDQualifier_name'] ?? '').toLowerCase() === 'note') return String(q['INSDQualifier_value'] ?? '');
  }
  return undefined;
}

export function extractST26Associations(content: string): Array<{ regionLabel: RegionLabel; seqId: number }> {
  let parsed: unknown;
  try { parsed = st26Parser.parse(content); } catch { return []; }
  const root = (parsed as { ST26SequenceListing?: { SequenceData?: unknown } })?.ST26SequenceListing;
  const data = asArray(root?.SequenceData) as Array<Record<string, unknown>>;
  const out: Array<{ regionLabel: RegionLabel; seqId: number }> = [];
  const seen = new Set<string>();
  for (const d of data) {
    const seqId = Number(d['@_sequenceIDNumber']);
    if (!Number.isInteger(seqId)) continue;
    const insd = (d.INSDSeq ?? {}) as Record<string, unknown>;
    const declaredLength = Number(insd['INSDSeq_length']);
    if (!Number.isInteger(declaredLength)) continue; // cannot disambiguate whole vs sub
    const table = (insd['INSDSeq_feature-table'] ?? {}) as Record<string, unknown>;
    for (const f of asArray(table['INSDFeature']) as Array<Record<string, unknown>>) {
      const note = noteValue(f);
      if (!note) continue;
      const label = normalizeRegionNote(note);
      if (!label) continue;
      const span = locationSpan(f['INSDFeature_location']);
      if (!span || !(span.start <= 1 && span.end >= declaredLength)) continue; // whole-sequence only
      const k = `${label}|${seqId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ regionLabel: label, seqId });
    }
  }
  return out;
}
```

In `packages/mcp-gateway/src/index.ts`, add to the patentExtract export:

```ts
export { normalizeRegionNote, extractST26Associations } from './patentExtract.js';
```

- [ ] **Step 4: Run to verify pass, then full gateway suite + build**

Run: `pnpm --filter @mrsirquanzo/sonny-mcp-gateway test -- patentExtract` (PASS), then `pnpm --filter @mrsirquanzo/sonny-mcp-gateway test` (PASS), then `pnpm -r build` (Done).

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-gateway/src/patentExtract.ts packages/mcp-gateway/src/index.ts packages/mcp-gateway/src/patentExtract.test.ts
git commit -m "feat(mcp-gateway): extractST26Associations derives whole-sequence region labels from features"
```

---

### Task 3: wire structured associations into `extractPatentData`

**Files:**
- Modify: `packages/core/src/patentData.ts`
- Test: `packages/core/src/patentData.test.ts`

**Interfaces:**
- Consumes: `isST26`, `extractST26Associations` from `@mrsirquanzo/sonny-mcp-gateway`.
- Produces: `extractPatentData` uses structured associations for ST.26 input, the LLM for text.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/patentData.test.ts`:

```ts
describe('extractPatentData ST.26 structured associations', () => {
  const ST26 = '<ST26SequenceListing><SequenceData sequenceIDNumber="1"><INSDSeq><INSDSeq_length>12</INSDSeq_length><INSDSeq_sequence>ARDYYGSSYFDY</INSDSeq_sequence><INSDSeq_feature-table><INSDFeature><INSDFeature_key>REGION</INSDFeature_key><INSDFeature_location>1..12</INSDFeature_location><INSDFeature_quals><INSDQualifier><INSDQualifier_name>note</INSDQualifier_name><INSDQualifier_value>CDR-H3</INSDQualifier_value></INSDQualifier></INSDFeature_quals></INSDFeature></INSDSeq_feature-table></INSDSeq></SequenceData></ST26SequenceListing>';

  it('uses ST.26 features and does NOT call the LLM', async () => {
    let llmCalls = 0;
    const model = { async generateStructured() { llmCalls++; return { associations: [] } as never; } };
    const out = await extractPatentData(ST26, model);
    expect(out.associations).toContainEqual(expect.objectContaining({ regionLabel: 'CDR-H3', seqId: 1 }));
    expect(llmCalls).toBe(0);
  });

  it('still uses the LLM for text patents', async () => {
    let llmCalls = 0;
    const model = { async generateStructured() { llmCalls++; return { associations: [{ regionLabel: 'VH', seqId: 1 }] } as never; } };
    const out = await extractPatentData('SEQ ID NO: 1\nEVQLVESGG\n\nThe heavy chain variable region is SEQ ID NO: 1.', model);
    expect(llmCalls).toBe(1);
    expect(out.associations).toContainEqual(expect.objectContaining({ regionLabel: 'VH', seqId: 1 }));
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @mrsirquanzo/sonny-core test -- patentData`
Expected: FAIL (LLM called for ST.26; no structured associations).

- [ ] **Step 3: Implement**

In `packages/core/src/patentData.ts`:

Extend the import:

```ts
import { extractPatentNumber, extractSequences, isST26, extractST26Associations } from '@mrsirquanzo/sonny-mcp-gateway';
```

In `extractPatentData`, replace the unconditional `const associations = await extractAssociations(markdown, model);` with:

```ts
  const associations = isST26(markdown)
    ? extractST26Associations(markdown)
    : await extractAssociations(markdown, model);
```

(Leave the rest of `extractPatentData` - `byId`, `computeCompleteness`, the return shape - unchanged; associations are still `{ regionLabel, seqId }`.)

- [ ] **Step 4: Run to verify pass, then full suites + build**

Run: `pnpm --filter @mrsirquanzo/sonny-core test -- patentData` (PASS), then `pnpm --filter @mrsirquanzo/sonny-core test` (PASS), then `pnpm -r build` (all 6 Done), then `pnpm -r test` (all pass).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/patentData.ts packages/core/src/patentData.test.ts
git commit -m "feat(core): use ST.26 structured associations for ST.26 patents, LLM for text"
```

---

## Self-review notes

- Task order: normalizer (1) -> feature extractor (2) -> wiring (3). Each independently testable.
- The whole-sequence rule is the crux: it prevents a sub-span CDR feature inside a larger chain from creating a bogus whole-SEQ association. Tested directly in Task 2.
- ST.26 replaces the LLM for associations (no wasted call, no XML-hallucination); text patents are byte-for-byte unchanged.
- Every mcp-gateway/core task runs `pnpm -r build` (real tsc).
