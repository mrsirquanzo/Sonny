# ANARCI Region-Confirmation Module Design (Patent Specialist - Slice 2)

**Status:** Approved, ready for implementation plan.
**Parent:** [Competitive IP & Patent Specialist - Overview Design](./2026-06-29-competitive-ip-patent-specialist-design.md).
**Slice:** 2 of 6.
**Date:** 2026-06-30.

## Purpose

Confirm a patent's own antibody region designations against gold-standard IMGT numbering, and report the closest-germline species of each variable domain.

The module does not invent annotations.
It takes the patent's declared region sequences and verifies them against the true regions derived from ANARCI's numbering of the full variable domain.

## The anchoring strategy (why full VH/VL, not bare CDRs)

ANARCI numbers a variable domain (a whole VH or VL), not an isolated region.
An HMM alignment of a bare 7-residue CDR is meaningless because there is no framework to anchor it.
Antibody patents that enable a functional molecule essentially always disclose the complete VH and VL sequences alongside the individual regions.

So the module anchors on the full VH/VL:
number the variable domain with ANARCI, derive the true CDR and framework coordinates from fixed IMGT positions, then substring/equality-match the patent's separately-declared region sequences against those derived regions.
Species comes from ANARCI's germline assignment on the same domain.

## Scope: variable domain only

ANARCI covers the variable domain.
This module confirms VH, VL, the six CDRs (CDR-H1/2/3, CDR-L1/2/3), and the four frameworks (FR-H1-4, FR-L1-4).

It does NOT cover Fc or the constant portions of a Fab (CH1, CL, hinge, CH2, CH3).
Those are constant domains, outside ANARCI's scope.
A claimed constant-region sequence (Fc, full heavy/light chain, Fab-constant) receives a `not_applicable_constant` status from this module; its correctness is established by BLAST identity (slice 1) against known IgG constant regions instead.

Division of labor: ANARCI owns variable-domain region confirmation; BLAST owns "is this a real, correctly-transcribed sequence" for everything, including constant regions.

## Components

1. **`anarci_confirm.py`** (Python bridge, lives beside the TS module in `packages/mcp-gateway`).
   - Reads JSON on stdin: `{ sequences: [{ id, seq }], scheme: 'imgt' }`.
   - Runs ANARCI's Python API with `assign_germline=True`.
   - Writes JSON on stdout: for each input, the domain numbering, chain type (`H` | `K` | `L`), and closest-germline species and V/J genes.
   - **stdout carries only the final JSON payload.** ANARCI and its HMMER backend can be noisy (deprecation warnings, alignment alerts). All Python `warnings`, `logging`, and any library chatter must be routed to stderr (suppress/redirect warnings and set logging to stderr at startup), so a rogue line can never corrupt the JSON the TypeScript side parses. A single warning leaking to stdout would break `JSON.parse` even when the biological computation succeeded.
   - Self-checks the `anarci` import at startup; if ANARCI is not importable it writes `{ "status": "anarci_unavailable", "error": "..." }` and exits cleanly (non-crashing), so the TypeScript layer maps it to a soft status.

2. **`anarci.ts`** (TypeScript, `packages/mcp-gateway`).
   - Exported as a typed function `confirmRegions(input, deps) => Promise<RegionConfirmation>`.
   - NOT registered in the Tool index and NOT a fetch-based `Tool`.
     ANARCI is local deterministic compute whose output is a structured confirmation report, not an LLM-decided search.
     The slice-5 orchestrator calls it directly; whether to expose an LLM-callable wrapper is a slice-5 decision.
   - Takes an injectable `exec` runner (`deps.exec`) so unit tests mock the subprocess and need no real ANARCI install.
   - Parses stdout only; stderr is ignored except when surfaced in an error diagnostic. This keeps warning noise from breaking the parse.

## Data flow

```
confirmRegions(input, { exec })
  -> exec spawns anarci_confirm.py, sends input sequences as JSON on stdin
  -> parse JSON from stdout
  -> derive true regions from IMGT positions in the numbering
  -> normalize + match each claimed region against the derived region
  -> assemble RegionConfirmation
```

IMGT region positions (fixed):
- FR1: 1-26, CDR1: 27-38, FR2: 39-55, CDR2: 56-65, FR3: 66-104, CDR3: 105-117, FR4: 118-128.

## Interfaces

### Input

```ts
type RegionLabel =
  | 'VH' | 'VL'
  | 'CDR-H1' | 'CDR-H2' | 'CDR-H3'
  | 'CDR-L1' | 'CDR-L2' | 'CDR-L3'
  | 'FR-H1' | 'FR-H2' | 'FR-H3' | 'FR-H4'
  | 'FR-L1' | 'FR-L2' | 'FR-L3' | 'FR-L4'
  | 'Fc' | 'CH1' | 'CL' | 'hinge' | 'heavy-chain' | 'light-chain' | 'Fab';

interface ConfirmInput {
  vh?: string;                                      // full heavy variable domain (anchor)
  vl?: string;                                      // full light variable domain (anchor)
  claimedRegions: Array<{ label: RegionLabel; sequence: string }>;
  scheme?: 'imgt';                                  // default 'imgt'; only imgt supported now
}
```

### Output

```ts
type RegionStatus =
  | 'confirmed'                // claimed sequence equals the ANARCI-derived region
  | 'mismatch'                 // claimed sequence differs from the derived region
  | 'not_applicable_constant'  // constant-region claim, outside ANARCI scope (see BLAST)
  | 'orphan_unverifiable'      // isolated region with no VH/VL anchor to number
  | 'anarci_unavailable';      // ANARCI not installed / failed to run

interface NumberedRegion {
  seq: string;
  imgtStart: number;
  imgtEnd: number;
  residues: Array<{ pos: string; aa: string }>;   // per-residue, carries IMGT insertion codes; feeds the slice-6 viewer
}

interface ConfirmedDomain {
  chain: 'H' | 'K' | 'L';
  species: string;                                  // closest-germline species, e.g. 'homo_sapiens', 'mus_musculus'
  germline: { v: string; j: string };
  numberedRegions: Partial<Record<RegionLabel, NumberedRegion>>;  // VH/VL + its CDRs + frameworks
}

interface RegionCheck {
  label: RegionLabel;
  claimedSeq: string;
  derivedSeq?: string;                              // present when a derived region existed to compare
  status: RegionStatus;
  note?: string;
}

interface RegionConfirmation {
  overallStatus: 'confirmed' | 'partial' | 'mismatch' | 'anarci_unavailable';
  domains: ConfirmedDomain[];                       // VH and/or VL, when anchored
  regionChecks: RegionCheck[];                      // one per claimed region
  speciesSummary: Array<{ chain: 'H' | 'K' | 'L'; species: string }>;
}
```

`overallStatus`:
- `anarci_unavailable` when the bridge reports ANARCI missing/failed.
- `confirmed` when every applicable (variable-domain) region check is `confirmed`.
- `mismatch` when at least one applicable region check is `mismatch`.
- `partial` otherwise (a mix that includes `orphan_unverifiable` or `not_applicable_constant` but no `mismatch`).

## Species / humanness scope

ANARCI returns the variable-domain closest-germline species per chain.
That is the clean "non-human antibody" signal (for example a murine VH/VL).
This module reports the precise per-domain species in `speciesSummary` and `ConfirmedDomain.species`.

Full human vs humanized vs chimeric classification requires combining variable-domain germline (this module) with constant-region evidence.
That final classification is a slice-5 synthesis, not this module.

## Match semantics

Normalize each sequence (uppercase, strip whitespace) before comparing.
Then require exact equality between the claimed region and the derived region.
On mismatch, report both `derivedSeq` and `claimedSeq` so the discrepancy is visible.
No fuzzy or partial matching (YAGNI); boundary-shift analysis is out of scope.

## Region routing (which status a claimed label gets)

- Variable-domain labels (VH, VL, CDR-*, FR-*): compared against the derived region -> `confirmed` or `mismatch`. If the needed anchor (VH for H-labels, VL for L-labels) was not provided or ANARCI could not number it, the label is `orphan_unverifiable`.
- Constant-region labels (Fc, CH1, CL, hinge, heavy-chain, light-chain, Fab): `not_applicable_constant`.
- Any label when ANARCI is unavailable: `anarci_unavailable`.

## Error handling

- ANARCI not installed / import error / bridge non-zero exit with the unavailable marker: `overallStatus = 'anarci_unavailable'`, every `regionCheck.status = 'anarci_unavailable'`, `domains = []`. Never throws for this case (soft degradation so the dossier still ships BLAST results).
- Malformed bridge output (not the unavailable marker, but unparseable): throw a clear error (a genuine bug, not a graceful state).
- Empty `claimedRegions` with a VH/VL provided: still returns `domains` (the numbering) with an empty `regionChecks`.

## Testing

All tests inject `deps.exec` returning canned bridge JSON; no real ANARCI install required.

- A VH is numbered; CDR-H1/2/3 and frameworks are derived at the correct IMGT positions.
- A claimed CDR-H1 equal to the derived region -> `confirmed`.
- A claimed CDR-H2 that differs -> `mismatch`, with both `derivedSeq` and `claimedSeq` present.
- A murine germline in the bridge output -> `speciesSummary` reports the non-human species.
- A kappa light domain -> `chain: 'K'`.
- An orphan CDR (a claimed CDR-H1 with no `vh` provided) -> `orphan_unverifiable`.
- A claimed Fc/constant region -> `not_applicable_constant`.
- The bridge emits the `anarci_unavailable` marker -> `overallStatus` and all region checks are `anarci_unavailable`, `domains` empty, no throw.
- Normalization: a claimed sequence with lowercase/whitespace still matches the derived region.
- **IMGT insertion codes:** the mock `exec` returns a VH whose numbering includes CDR-H3 insertion codes (for example positions `111`, `111A`, `111B`, `112B`, `112A`, `112`). The derived CDR-H3 must preserve those inserted residues in IMGT order, and every `residues[].pos` must remain a string with its trailing letter intact - never cast to an integer or dropped. A claimed CDR-H3 that includes the inserted residues then matches the derived region.

## Setup

Documented one-time setup: `conda install -c bioconda anarci hmmer`.
Real end-to-end behavior is validated by a manual smoke against a known antibody VH/VL (not a unit test), which also confirms the bridge JSON shape matches the fixtures.

## Out of scope

- Fc / constant-region confirmation (handled by BLAST, slice 1).
- Human/humanized/chimeric classification (slice 5 synthesis).
- Non-IMGT schemes (Kabat/Chothia).
- Boundary-shift / fuzzy matching.
- Registering an LLM-callable tool wrapper (slice-5 decision).
