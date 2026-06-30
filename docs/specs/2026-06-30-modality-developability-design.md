# Phase 2: Modality & Developability Specialist - Design

**Status:** Approved, ready for implementation plan.
**Slice:** 13 (VP judgment layer part 2).
**Date:** 2026-06-30.

## Goal

Shift from pure biology to chemistry and manufacturing reality.
Add a sixth specialist that assesses whether the target can actually be drugged - half-life, dosing, immunogenicity, off-target toxicity, Fc-engineering, manufacturability - and let a severe developability liability drive the GO/WATCH/NO-GO verdict the way a VP kills an undruggable program.

## The principled distinction (why this differs from Slice 1)

Slice 1 (the skeptic's audit) flags *evidence quality* - a post-hoc study - and **never** changes the verdict; it surfaces context.
Phase 2 flags *the asset itself* - a severely immunogenic molecule - and **does** drive the verdict.
A VP does not kill a target because one paper was unblinded, but does kill it because the molecule is undruggable.
These are deliberately separate mechanisms:

- **Methodological bias (Slice 1):** `RedFlag` / `MethodologicalCritique`, surface-don't-penalize, tiers `low | moderate | high`.
- **Developability risk (Phase 2):** `DevelopabilityRisk`, gate-the-verdict, tiers `manageable | significant | severe`. `severe` is a hard NO-GO.

## Design

### 1. Sixth specialist (`researchRoster.ts`)

Add a `Modality & Developability` brief to `RESEARCH_ROSTER`. `runDeepResearch` already fans the roster out in parallel over the shared store, so it runs alongside the others with no orchestrator change.

- `id: 'modality_developability'`, `title: 'Modality & Developability'`.
- `promptHint` locks the specialist to physical/developability constraints and tells it to ignore disease biology: antibody/protein half-life and dosing route (IV vs subcutaneous), immunogenicity and anti-drug-antibody (ADA) risk, off-target and on-target/off-tumor toxicity, Fc-engineering and format risks, and manufacturability.

### 2. `DevelopabilityRisk` schema (`@sonny/shared`)

```ts
DevelopabilitySeverity = 'manageable' | 'significant' | 'severe'
DevelopabilityCategory = 'immunogenicity' | 'half_life' | 'dosing' | 'off_target_toxicity' | 'fc_engineering' | 'manufacturability'
DevelopabilityRisk     = { evidenceId: string, category: DevelopabilityCategory, severity: DevelopabilitySeverity, explanation: string (min 1) }
```

- `Section` gains `developabilityRisks?: DevelopabilityRisk[]`.
- `TraceEvent` gains `{ type: 'developability_assessment', risks: DevelopabilityRisk[] }`.

### 3. Decorrelated developability assessor (`core/critique/developability.ts`)

`assessDevelopability({ section, store, model, emit }): Promise<DevelopabilityRisk[]>`
- Reads the modality section's verified claims and the evidence behind them and produces structured developability risks, each attributed to a specific `evidenceId`.
- **Grounded (no token, no ship):** risks whose `evidenceId` is not a real id in the store are dropped - a risk must rest on registered evidence.
- **Decorrelated (Rule 3):** runs on `MODEL_ROUTER.verifier`, not the specialist that wrote the claims.
- Emits `developability_assessment` with the surviving risks.

### 4. Wire into `runDeepResearch`

After `finalSections` is computed (post gap-fill) and before synthesis, run `assessDevelopability` on the section whose id is `modality_developability`, attach the risks to that section, wrapped in try/catch so a failure degrades to a normal run.

### 5. The verdict gate (`synthesize.ts`)

- The findings digest lists the developability risks (significant and severe) so the writer can weigh them in the bear case.
- The writer system prompt states: a severe developability liability is a dealbreaker - the verdict cannot be `go`; weigh significant developability risks in the bear case.
- **Deterministic override:** after the writer drafts, if any section carries a `severe` developability risk, the verdict is forced to `no-go` regardless of the drafted verdict. `significant`/`manageable` risks inform the writer but do not override.

### CLI (`apps/cli/src/run.ts`)

`formatTrace` renders `developability_assessment`: `LEAD developability: severe immunogenicity - <explanation>; significant ...` or `- no material risks`.

## Out of scope

- Probability-of-success scoring, translational strategy (later VP-layer slices).
- A developability-specific tool (the specialist uses the existing literature tools).
- Changing the RAG formula or the methodological-audit mechanism.

## Testing

- **Contracts:** `DevelopabilityRiskSchema` rejects invalid severity (e.g. `fatal`, `blocker`) and invalid category and empty explanation; valid parses; `Section.developabilityRisks` is optional.
- **Roster:** `RESEARCH_ROSTER` has 6 briefs, includes `modality_developability` with a non-empty objective/promptHint; update the existing roster test's id list and size to 6.
- **assessDevelopability:** with a mock model, produces grounded risks; a risk citing an unknown evidenceId is dropped (no token, no ship); uses the verifier model id; emits the trace event.
- **synthesize gate:** a section carrying a `severe` developability risk forces the final verdict to `no-go` even when the writer drafts `go` (perfect biology); a `significant`-only run does not override; the risk explanation appears in the writer prompt.
- Full repo suite green.

## Success criteria

A local CDCP1 smoke shows the `Modality & Developability` specialist running in parallel, a `developability` assessment line in the trace, and - when the assessor flags a severe liability - a NO-GO verdict with the developability dealbreaker named in the dossier, even if the biology sections are green.
