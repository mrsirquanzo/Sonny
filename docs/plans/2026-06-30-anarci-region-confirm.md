# ANARCI Region-Confirmation Module Implementation Plan (Patent Specialist - Slice 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `confirmRegions` module that confirms a patent's antibody region designations against IMGT numbering (via a Python ANARCI bridge) and reports each variable domain's closest-germline species.

**Architecture:** Two units in `packages/mcp-gateway`. Task 1 is pure TypeScript (IMGT region derivation, normalization, matching, label routing) with no subprocess. Task 2 adds the Python bridge (`anarci_confirm.py`), an injectable `exec` runner over `node:child_process`, and the `confirmRegions` assembly that ties them together. It is a plain typed function, NOT a registered `Tool`. Unit tests inject `exec` and never call real ANARCI.

**Tech Stack:** TypeScript ESM, Vitest, Node `child_process`, Python 3 + ANARCI (runtime only; not needed for unit tests). Test runner: `pnpm --filter @sonny/mcp-gateway test`.

**Spec:** [docs/specs/2026-06-30-anarci-region-confirm-design.md](../specs/2026-06-30-anarci-region-confirm-design.md).

## Global Constraints

- Never use the em dash; use a plain hyphen.
- Never auto-add a commit co-author.
- ESM relative imports use the `.js` extension.
- Touch only `packages/mcp-gateway/src/anarci.ts`, `packages/mcp-gateway/src/anarci.test.ts`, `packages/mcp-gateway/src/anarci_confirm.py`, and `packages/mcp-gateway/src/index.ts`.
- `confirmRegions` is a plain exported function, NOT a `Tool`, and is NOT added to any tool registry array.
- ANARCI is never required for unit tests; all tests inject `deps.exec`.
- IMGT positions are strings (insertion codes like `111A`); never cast a position to an integer in a way that drops its trailing letter.

## File Structure

- Create: `packages/mcp-gateway/src/anarci.ts` - types, pure region logic (Task 1), then the bridge + `confirmRegions` (Task 2).
- Create: `packages/mcp-gateway/src/anarci.test.ts` - unit tests for both tasks.
- Create: `packages/mcp-gateway/src/anarci_confirm.py` - the Python ANARCI bridge (Task 2).
- Modify: `packages/mcp-gateway/src/index.ts` - export `confirmRegions` and its public types.

## IMGT reference (used throughout)

Region numeric ranges: FR1 1-26, CDR1 27-38, FR2 39-55, CDR2 56-65, FR3 66-104, CDR3 105-117, FR4 118-128.

---

### Task 1: Types and pure region logic

**Files:**
- Create: `packages/mcp-gateway/src/anarci.ts`
- Test: `packages/mcp-gateway/src/anarci.test.ts`

**Interfaces:**
- Produces (types): `RegionLabel`, `NumberedRegion`, `Numbering`, `ConfirmInput`, `RegionStatus`, `ConfirmedDomain`, `RegionCheck`, `RegionConfirmation`.
- Produces (functions): `normalizeSeq(s)`, `deriveRegions(numbering)`, `matchRegion(a, b)`, `isConstantLabel(label)`, `anchorChainFor(label)`.
- `deriveRegions` preserves position strings verbatim (insertion codes intact) and skips gap residues (`-`).

- [ ] **Step 1: Write the failing tests**

Create `packages/mcp-gateway/src/anarci.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  normalizeSeq, deriveRegions, matchRegion, isConstantLabel, anchorChainFor,
} from './anarci.js';
import type { Numbering } from './anarci.js';

// A minimal heavy-domain numbering with a CDR-H3 that carries IMGT insertion codes.
// FR-H1 covers 1-26, CDR-H1 27-38, and CDR-H3 105-117 (with 111A/111B/112B/112A inserts).
const NUMBERING: Numbering = [
  ['1', 'E'], ['2', 'V'], ['3', 'Q'], ['26', 'C'],       // FR1 (sparse is fine)
  ['27', 'G'], ['28', 'F'], ['38', 'S'],                 // CDR1
  ['105', 'A'], ['106', 'R'], ['111', 'G'], ['111A', 'Y'], ['111B', 'D'],
  ['112B', 'S'], ['112A', 'F'], ['112', 'D'], ['117', 'Y'], // CDR3 with inserts
  ['118', 'W'], ['128', 'S'],                            // FR4
];

describe('normalizeSeq', () => {
  it('uppercases and strips whitespace', () => {
    expect(normalizeSeq('  ev ql\nv ')).toBe('EVQLV');
  });
});

describe('deriveRegions', () => {
  it('buckets residues into IMGT regions and preserves insertion-code positions as strings', () => {
    const r = deriveRegions(NUMBERING);
    expect(r.CDR1.seq).toBe('GFS');
    expect(r.CDR3.seq).toBe('ARGYDSFDY');                // insert residues kept, in given order
    const posList = r.CDR3.residues.map((x) => x.pos);
    expect(posList).toEqual(['105', '106', '111', '111A', '111B', '112B', '112A', '112', '117']);
    expect(r.CDR3.residues.some((x) => x.pos === '111A' && x.aa === 'Y')).toBe(true);
    expect(r.CDR3.imgtStart).toBe(105);
    expect(r.CDR3.imgtEnd).toBe(117);
  });

  it('skips gap residues', () => {
    const r = deriveRegions([['27', 'G'], ['28', '-'], ['29', 'F']] as Numbering);
    expect(r.CDR1.seq).toBe('GF');
  });
});

describe('matchRegion', () => {
  it('matches after normalization, rejects a different sequence', () => {
    expect(matchRegion('gfs', 'GFS')).toBe(true);
    expect(matchRegion('GFT', 'GFS')).toBe(false);
  });
});

describe('label routing', () => {
  it('flags constant labels', () => {
    expect(isConstantLabel('Fc')).toBe(true);
    expect(isConstantLabel('CDR-H1')).toBe(false);
  });
  it('resolves the anchor chain a label needs', () => {
    expect(anchorChainFor('CDR-H1')).toBe('H');
    expect(anchorChainFor('VH')).toBe('H');
    expect(anchorChainFor('CDR-L2')).toBe('light');
    expect(anchorChainFor('Fc')).toBe(null);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/mcp-gateway test -- anarci`
Expected: FAIL - `anarci.js` does not exist yet.

- [ ] **Step 3: Implement types and pure logic**

Create `packages/mcp-gateway/src/anarci.ts`:

```ts
export type RegionLabel =
  | 'VH' | 'VL'
  | 'CDR-H1' | 'CDR-H2' | 'CDR-H3'
  | 'CDR-L1' | 'CDR-L2' | 'CDR-L3'
  | 'FR-H1' | 'FR-H2' | 'FR-H3' | 'FR-H4'
  | 'FR-L1' | 'FR-L2' | 'FR-L3' | 'FR-L4'
  | 'Fc' | 'CH1' | 'CL' | 'hinge' | 'heavy-chain' | 'light-chain' | 'Fab';

export type Numbering = Array<[string, string]>; // [positionString, aa]; aa '-' is a gap

export interface NumberedRegion {
  seq: string;
  imgtStart: number;
  imgtEnd: number;
  residues: Array<{ pos: string; aa: string }>;
}

export interface ConfirmInput {
  vh?: string;
  vl?: string;
  claimedRegions: Array<{ label: RegionLabel; sequence: string }>;
  scheme?: 'imgt';
}

export type RegionStatus =
  | 'confirmed' | 'mismatch' | 'not_applicable_constant' | 'orphan_unverifiable' | 'anarci_unavailable';

export interface ConfirmedDomain {
  chain: 'H' | 'K' | 'L';
  species: string;
  germline: { v: string; j: string };
  numberedRegions: Partial<Record<RegionLabel, NumberedRegion>>;
}

export interface RegionCheck {
  label: RegionLabel;
  claimedSeq: string;
  derivedSeq?: string;
  status: RegionStatus;
  note?: string;
}

export interface RegionConfirmation {
  overallStatus: 'confirmed' | 'partial' | 'mismatch' | 'anarci_unavailable';
  domains: ConfirmedDomain[];
  regionChecks: RegionCheck[];
  speciesSummary: Array<{ chain: 'H' | 'K' | 'L'; species: string }>;
}

const IMGT_RANGES: Array<{ region: string; start: number; end: number }> = [
  { region: 'FR1', start: 1, end: 26 },
  { region: 'CDR1', start: 27, end: 38 },
  { region: 'FR2', start: 39, end: 55 },
  { region: 'CDR2', start: 56, end: 65 },
  { region: 'FR3', start: 66, end: 104 },
  { region: 'CDR3', start: 105, end: 117 },
  { region: 'FR4', start: 118, end: 128 },
];

const CONSTANT_LABELS: RegionLabel[] = ['Fc', 'CH1', 'CL', 'hinge', 'heavy-chain', 'light-chain', 'Fab'];

export function normalizeSeq(s: string): string {
  return s.replace(/\s+/g, '').toUpperCase();
}

function imgtNumber(pos: string): number {
  return parseInt(pos, 10); // numeric prefix; insertion letter is ignored for range bucketing only
}

export function deriveRegions(numbering: Numbering): Record<string, NumberedRegion> {
  const buckets: Record<string, Array<{ pos: string; aa: string }>> = {};
  for (const [pos, aa] of numbering) {
    if (aa === '-' || aa === '') continue;
    const n = imgtNumber(pos);
    const slot = IMGT_RANGES.find((r) => n >= r.start && n <= r.end);
    if (!slot) continue;
    (buckets[slot.region] ??= []).push({ pos, aa }); // pos preserved verbatim (insertion codes intact)
  }
  const out: Record<string, NumberedRegion> = {};
  for (const { region } of IMGT_RANGES) {
    const residues = buckets[region];
    if (!residues || residues.length === 0) continue;
    const nums = residues.map((r) => imgtNumber(r.pos));
    out[region] = {
      seq: residues.map((r) => r.aa).join(''),
      imgtStart: Math.min(...nums),
      imgtEnd: Math.max(...nums),
      residues,
    };
  }
  return out;
}

export function matchRegion(claimed: string, derived: string): boolean {
  return normalizeSeq(claimed) === normalizeSeq(derived);
}

export function isConstantLabel(label: RegionLabel): boolean {
  return CONSTANT_LABELS.includes(label);
}

export function anchorChainFor(label: RegionLabel): 'H' | 'light' | null {
  if (label === 'VH' || /-H[1-4]$/.test(label)) return 'H';
  if (label === 'VL' || /-L[1-4]$/.test(label)) return 'light';
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/mcp-gateway test -- anarci`
Expected: PASS - all Task 1 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-gateway/src/anarci.ts packages/mcp-gateway/src/anarci.test.ts
git commit -m "feat(mcp-gateway): IMGT region derivation and label-routing helpers for ANARCI confirmation"
```

---

### Task 2: Python bridge, exec runner, and `confirmRegions`

**Files:**
- Create: `packages/mcp-gateway/src/anarci_confirm.py`
- Modify: `packages/mcp-gateway/src/anarci.ts` (append bridge + `confirmRegions`; add the two `import` lines at the TOP of the file)
- Test: `packages/mcp-gateway/src/anarci.test.ts` (append)
- Modify: `packages/mcp-gateway/src/index.ts`

**Interfaces:**
- Consumes: all Task 1 exports.
- Produces: `type Exec`, `confirmRegions(input: ConfirmInput, deps?: { exec?: Exec }): Promise<RegionConfirmation>`.
- Bridge output JSON contract (what `anarci_confirm.py` writes to stdout):
  `{ "status": "ok" | "anarci_unavailable", "error"?: string, "domains"?: Array<{ inputId, chain: 'H'|'K'|'L', species, germline: { v, j }, numbering: Array<[string, string]> }> }`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/mcp-gateway/src/anarci.test.ts`:

```ts
import { confirmRegions } from './anarci.js';
import type { Exec } from './anarci.js';

// Bridge output for a heavy domain: human germline, CDR-H1 = GFS, CDR-H3 = ARGYDSFDY (with inserts).
const HEAVY_BRIDGE = JSON.stringify({
  status: 'ok',
  domains: [{
    inputId: 'vh', chain: 'H', species: 'homo_sapiens',
    germline: { v: 'IGHV3-23*01', j: 'IGHJ4*02' },
    numbering: [
      ['27', 'G'], ['28', 'F'], ['38', 'S'],
      ['105', 'A'], ['106', 'R'], ['111', 'G'], ['111A', 'Y'], ['111B', 'D'],
      ['112B', 'S'], ['112A', 'F'], ['112', 'D'], ['117', 'Y'],
    ],
  }],
});
const MOUSE_KAPPA_BRIDGE = JSON.stringify({
  status: 'ok',
  domains: [{
    inputId: 'vl', chain: 'K', species: 'mus_musculus',
    germline: { v: 'IGKV4-1*01', j: 'IGKJ1*01' },
    numbering: [['27', 'Q'], ['28', 'S'], ['38', 'L']],
  }],
});
const execReturning = (stdout: string): Exec => (async () => ({ stdout, stderr: '', code: 0 }));

describe('confirmRegions', () => {
  it('confirms a matching CDR-H1 and derives the insertion-coded CDR-H3', async () => {
    const out = await confirmRegions(
      { vh: 'EVQ', claimedRegions: [{ label: 'CDR-H1', sequence: 'GFS' }, { label: 'CDR-H3', sequence: 'ARGYDSFDY' }] },
      { exec: execReturning(HEAVY_BRIDGE) },
    );
    expect(out.overallStatus).toBe('confirmed');
    expect(out.regionChecks.find((c) => c.label === 'CDR-H1')?.status).toBe('confirmed');
    expect(out.regionChecks.find((c) => c.label === 'CDR-H3')?.status).toBe('confirmed');
    const vh = out.domains[0].numberedRegions.VH;
    expect(vh?.residues.some((r) => r.pos === '111A')).toBe(true); // insertion code preserved end to end
    expect(out.speciesSummary).toEqual([{ chain: 'H', species: 'homo_sapiens' }]);
  });

  it('reports a mismatch with both sequences', async () => {
    const out = await confirmRegions(
      { vh: 'EVQ', claimedRegions: [{ label: 'CDR-H1', sequence: 'GFT' }] },
      { exec: execReturning(HEAVY_BRIDGE) },
    );
    expect(out.overallStatus).toBe('mismatch');
    const check = out.regionChecks[0];
    expect(check.status).toBe('mismatch');
    expect(check.derivedSeq).toBe('GFS');
    expect(check.claimedSeq).toBe('GFT');
  });

  it('reports the non-human species and kappa chain for a murine light domain', async () => {
    const out = await confirmRegions(
      { vl: 'QSV', claimedRegions: [] },
      { exec: execReturning(MOUSE_KAPPA_BRIDGE) },
    );
    expect(out.domains[0].chain).toBe('K');
    expect(out.speciesSummary).toEqual([{ chain: 'K', species: 'mus_musculus' }]);
  });

  it('flags an orphan CDR (no anchor domain) as orphan_unverifiable', async () => {
    const out = await confirmRegions(
      { claimedRegions: [{ label: 'CDR-H1', sequence: 'GFS' }] },
      { exec: execReturning(JSON.stringify({ status: 'ok', domains: [] })) },
    );
    expect(out.regionChecks[0].status).toBe('orphan_unverifiable');
  });

  it('flags a constant-region claim as not_applicable_constant', async () => {
    const out = await confirmRegions(
      { vh: 'EVQ', claimedRegions: [{ label: 'Fc', sequence: 'DKTHT' }] },
      { exec: execReturning(HEAVY_BRIDGE) },
    );
    expect(out.regionChecks[0].status).toBe('not_applicable_constant');
  });

  it('soft-degrades to anarci_unavailable without throwing', async () => {
    const out = await confirmRegions(
      { vh: 'EVQ', claimedRegions: [{ label: 'CDR-H1', sequence: 'GFS' }] },
      { exec: execReturning(JSON.stringify({ status: 'anarci_unavailable', error: 'no module named anarci' })) },
    );
    expect(out.overallStatus).toBe('anarci_unavailable');
    expect(out.regionChecks[0].status).toBe('anarci_unavailable');
    expect(out.domains).toEqual([]);
  });

  it('throws on unparseable bridge stdout', async () => {
    await expect(
      confirmRegions(
        { vh: 'EVQ', claimedRegions: [] },
        { exec: execReturning('WARNING: rogue line\n{not json}') },
      ),
    ).rejects.toThrow(/unparseable/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/mcp-gateway test -- anarci`
Expected: FAIL - `confirmRegions` / `Exec` are not exported yet.

- [ ] **Step 3: Implement the bridge assembly**

Add these two imports at the TOP of `packages/mcp-gateway/src/anarci.ts` (above the Task 1 code):

```ts
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
```

Append to the bottom of `packages/mcp-gateway/src/anarci.ts`:

```ts
export type Exec = (scriptPath: string, stdin: string) => Promise<{ stdout: string; stderr: string; code: number }>;

interface BridgeDomain {
  inputId: string;
  chain: 'H' | 'K' | 'L';
  species: string;
  germline: { v: string; j: string };
  numbering: Numbering;
}
interface BridgeOutput { status: 'ok' | 'anarci_unavailable'; error?: string; domains?: BridgeDomain[] }

const SCRIPT_PATH = fileURLToPath(new URL('./anarci_confirm.py', import.meta.url));

const defaultExec: Exec = (scriptPath, stdin) =>
  new Promise((resolve, reject) => {
    const py = process.env.SONNY_PYTHON ?? 'python3';
    const child = spawn(py, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    child.stdin.write(stdin);
    child.stdin.end();
  });

function fullDomainRegion(numbering: Numbering): NumberedRegion {
  const residues = numbering.filter(([, aa]) => aa !== '-' && aa !== '').map(([pos, aa]) => ({ pos, aa }));
  const nums = residues.map((r) => parseInt(r.pos, 10));
  return { seq: residues.map((r) => r.aa).join(''), imgtStart: Math.min(...nums), imgtEnd: Math.max(...nums), residues };
}

function labelRegions(numbering: Numbering, chain: 'H' | 'K' | 'L'): Partial<Record<RegionLabel, NumberedRegion>> {
  const generic = deriveRegions(numbering);
  const suffix = chain === 'H' ? 'H' : 'L';
  const out: Partial<Record<RegionLabel, NumberedRegion>> = {};
  out[chain === 'H' ? 'VH' : 'VL'] = fullDomainRegion(numbering);
  for (const [key, region] of Object.entries(generic)) {
    const m = key.match(/^(CDR|FR)([1-4])$/);
    if (m) out[`${m[1]}-${suffix}${m[2]}` as RegionLabel] = region;
  }
  return out;
}

function checkRegion(
  claim: { label: RegionLabel; sequence: string },
  domains: ConfirmedDomain[],
): RegionCheck {
  if (isConstantLabel(claim.label)) {
    return { label: claim.label, claimedSeq: claim.sequence, status: 'not_applicable_constant' };
  }
  const anchor = anchorChainFor(claim.label);
  const domain = domains.find((d) => (anchor === 'H' ? d.chain === 'H' : d.chain === 'K' || d.chain === 'L'));
  if (!domain) {
    return { label: claim.label, claimedSeq: claim.sequence, status: 'orphan_unverifiable', note: 'no variable-domain anchor to number' };
  }
  const derived = domain.numberedRegions[claim.label];
  if (!derived) {
    return { label: claim.label, claimedSeq: claim.sequence, status: 'orphan_unverifiable', note: 'region not present in numbered domain' };
  }
  const ok = matchRegion(claim.sequence, derived.seq);
  return { label: claim.label, claimedSeq: claim.sequence, derivedSeq: derived.seq, status: ok ? 'confirmed' : 'mismatch' };
}

function computeOverall(checks: RegionCheck[]): RegionConfirmation['overallStatus'] {
  if (checks.length === 0) return 'confirmed';
  if (checks.some((c) => c.status === 'mismatch')) return 'mismatch';
  if (checks.every((c) => c.status === 'confirmed')) return 'confirmed';
  return 'partial';
}

export async function confirmRegions(
  input: ConfirmInput,
  deps: { exec?: Exec } = {},
): Promise<RegionConfirmation> {
  const exec = deps.exec ?? defaultExec;
  const scheme = input.scheme ?? 'imgt';

  const sequences: Array<{ id: string; seq: string }> = [];
  if (input.vh) sequences.push({ id: 'vh', seq: normalizeSeq(input.vh) });
  if (input.vl) sequences.push({ id: 'vl', seq: normalizeSeq(input.vl) });

  let bridge: BridgeOutput;
  if (sequences.length === 0) {
    bridge = { status: 'ok', domains: [] };
  } else {
    const { stdout, code } = await exec(SCRIPT_PATH, JSON.stringify({ sequences, scheme }));
    try {
      bridge = JSON.parse(stdout) as BridgeOutput;
    } catch {
      throw new Error(`anarci bridge: unparseable stdout (exit ${code})`);
    }
  }

  if (bridge.status === 'anarci_unavailable') {
    return {
      overallStatus: 'anarci_unavailable',
      domains: [],
      regionChecks: input.claimedRegions.map((r) => ({ label: r.label, claimedSeq: r.sequence, status: 'anarci_unavailable' as const })),
      speciesSummary: [],
    };
  }

  const domains: ConfirmedDomain[] = (bridge.domains ?? []).map((d) => ({
    chain: d.chain,
    species: d.species,
    germline: d.germline,
    numberedRegions: labelRegions(d.numbering, d.chain),
  }));
  const speciesSummary = domains.map((d) => ({ chain: d.chain, species: d.species }));
  const regionChecks = input.claimedRegions.map((r) => checkRegion(r, domains));

  return { overallStatus: computeOverall(regionChecks), domains, regionChecks, speciesSummary };
}
```

- [ ] **Step 4: Create the Python bridge**

Create `packages/mcp-gateway/src/anarci_confirm.py`:

```python
"""ANARCI bridge for Sonny. Reads {sequences,scheme} JSON on stdin, writes one JSON object on stdout.

Contract: stdout carries ONLY the final JSON. All warnings/logging go to stderr so a stray
line can never corrupt the JSON the TypeScript side parses.
"""
import sys
import json
import warnings
import logging


def emit(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


def gene_str(entry):
    # ANARCI germline entry looks like [(species, gene), score]; be defensive about shape.
    try:
        return str(entry[0][1])
    except (IndexError, TypeError):
        return ""


def species_str(entry):
    try:
        return str(entry[0][0])
    except (IndexError, TypeError):
        return ""


def main():
    # Route noise away from stdout.
    warnings.simplefilter("ignore")
    logging.basicConfig(stream=sys.stderr, level=logging.ERROR)

    try:
        from anarci import anarci
    except Exception as exc:  # ANARCI/HMMER not installed
        emit({"status": "anarci_unavailable", "error": str(exc)})
        return

    req = json.loads(sys.stdin.read())
    scheme = req.get("scheme", "imgt")
    seqs = [(s["id"], s["seq"]) for s in req.get("sequences", [])]

    numbered, details, _hits = anarci(seqs, scheme=scheme, assign_germline=True, output=False)

    out_domains = []
    for i, (seq_id, _seq) in enumerate(seqs):
        dom = numbered[i]
        det = details[i]
        if not dom:
            continue  # no variable domain aligned (orphan / non-antibody)
        numbering_list = dom[0][0]           # [ ((num:int, ins:str), aa:str), ... ]
        d0 = det[0]
        germ = d0.get("germlines", {}) or {}
        numbering = [["{}{}".format(num, ins).strip(), aa] for ((num, ins), aa) in numbering_list]
        out_domains.append({
            "inputId": seq_id,
            "chain": d0.get("chain_type", "H"),
            "species": species_str(germ.get("v_gene")) or d0.get("species", ""),
            "germline": {"v": gene_str(germ.get("v_gene")), "j": gene_str(germ.get("j_gene"))},
            "numbering": numbering,
        })

    emit({"status": "ok", "domains": out_domains})


if __name__ == "__main__":
    main()
```

Note: the exact ANARCI field access (`germlines`, `chain_type`, tuple shapes) is validated by the manual smoke below and may need a small adjustment against the installed ANARCI version. The stable contract is the bridge JSON shape the TypeScript side consumes, which the unit tests pin.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/mcp-gateway test -- anarci`
Expected: PASS - all Task 1 and Task 2 tests pass.

- [ ] **Step 6: Export from the gateway index**

In `packages/mcp-gateway/src/index.ts`, add below the existing exports:

```ts
export { confirmRegions } from './anarci.js';
export type {
  ConfirmInput, RegionConfirmation, RegionCheck, RegionStatus,
  ConfirmedDomain, NumberedRegion, RegionLabel, Exec,
} from './anarci.js';
```

- [ ] **Step 7: Run the full gateway suite**

Run: `pnpm --filter @sonny/mcp-gateway test`
Expected: PASS - all gateway tests green (BLAST tests plus the new ANARCI tests).

- [ ] **Step 8: Commit**

```bash
git add packages/mcp-gateway/src/anarci.ts packages/mcp-gateway/src/anarci.test.ts packages/mcp-gateway/src/anarci_confirm.py packages/mcp-gateway/src/index.ts
git commit -m "feat(mcp-gateway): add confirmRegions ANARCI bridge for IMGT region and species confirmation"
```

---

## Notes for the controller

- Manual smoke (not a unit test), after `conda install -c bioconda anarci hmmer`: run `confirmRegions` against a known human antibody VH/VL and confirm the bridge JSON shape matches the fixtures (chain type, germline species, numbering with insertion codes). Adjust the Python field access if the installed ANARCI version differs; the TypeScript contract stays fixed.
- Out of scope for this slice: human/humanized/chimeric classification (slice 5), Fc/constant confirmation (BLAST, slice 1), the alignment viewer (slice 6), any LLM-callable tool wrapper.
