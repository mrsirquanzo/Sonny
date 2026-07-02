# Slice 1: The Skeptic's Audit (Methodological Critic) - Design

**Status:** Approved, ready for implementation plan.
**Slice:** 12 (first slice of the "VP / Principal Scientist judgment layer").
**Date:** 2026-06-30.

## Goal

Elevate Sonny from a literature compiler toward a 20-year Biopharma VP by adding a methodological skeptic.
After a paper is deep-read, an independent critic audits its study design and reporting for bias risk, and that judgment is surfaced in the dossier alongside the finding - never used to silently drop or numerically penalize it.

This is the cheapest, highest-signal piece of veteran judgment: a senior scientist reading a finding immediately asks "how was this measured, and how much should I trust it?"

## Principles this slice must honor

- **Strict TDD.** Failing Vitest first for every change.
- **Structured output only.** The audit returns a Zod-validated object; no regex.
- **Decorrelated verification (non-negotiable).** The critic runs on the verifier-role model (llama3.1:8b local), not the specialist that wrote the claims, so it cannot rubber-stamp its own reading. This requires threading the verifier model into `runResearcher`.
- **No token, no ship.** The critique's `evidenceId` is the audited paper's own store id (set in code, never by the model), so it is grounded by construction.

## Recalibrated lexicon

Objective risk categorization, not invalidation.
Bias risk tiers are `low | moderate | high` - no `fatal`, no `red/amber`, no dismissive language in schema or prompt.

## Behavior: keep the data, surface the context

A methodological flag never drops a claim and never lowers its confidence.
The grounding gate is orthogonal and unchanged: ungrounded claims still drop (no token, no ship), but a grounded claim with a bias flag always survives and carries the caveat forward.
When a claim rests on audited evidence with a moderate/high flag, that metadata rides into the writer, which weaves it into prose:

> "The study reported a 3-point eGFR improvement [PMID:...]; however, the audit notes this was derived from an unpowered post-hoc subgroup."

## Schema (`@sonny/shared`)

```ts
BiasRisk            = 'low' | 'moderate' | 'high'
RedFlagCategory     = 'surrogate_endpoint' | 'high_dropout' | 'p_hacking' | 'active_control_mismatch' | 'unblinded'
RedFlag             = { category: RedFlagCategory, biasRisk: BiasRisk, explanation: string (min 1) }
StudyDesign         = 'randomized_controlled' | 'single_arm' | 'post_hoc' | 'observational' | 'preclinical_nhp' | 'in_vitro'
MethodologicalCritique = { evidenceId: string, studyDesign: StudyDesign, sampleSize?: number|null, redFlags: RedFlag[] }
```

- `Claim` gains `redFlags?: RedFlag[]` (the flags that touch this finding).
- `Section` gains `critiques?: MethodologicalCritique[]` (the section's full audit record).
- `TraceEvent` gains `{ type: 'methodological_critique', specialist: string, critique: MethodologicalCritique }` for the glass-box stream.

The model's output schema is a subset (`studyDesign`, `sampleSize`, `redFlags`); `runSkepticAudit` assembles the full critique by attaching `evidenceId = paper.id`, so the id is always a real store id.

## Core logic (`@sonny/core`)

### `critique/skepticAudit.ts`

`runSkepticAudit(paper: Evidence, model: StructuredModel): Promise<MethodologicalCritique>`
- Prompts an independent methodological reviewer to classify study design, report sample size, and list objective bias red flags from the passage.
- Prompt instructs: categorize risk objectively, do not invalidate or dismiss; only raise a flag the passage supports; for preclinical/in-vitro work, clinical-trial flags usually do not apply (return an empty list).
- Uses `MODEL_ROUTER.verifier` for the model id; the caller passes the verifier model instance.

### `researcher.ts` wiring

- `runResearcher` opts gain a required `verifierModel: StructuredModel`.
- After a paper is deep-read (inside the existing `if (top)` block, after passages register), run `runSkepticAudit(top, verifierModel)`, wrapped in try/catch so an audit failure degrades silently (emits an error, never aborts the loop).
- Emit `methodological_critique`.
- Record the audited paper's evidence-id set (`top.id` plus the registered section ids) with its red flags.
- After `extractClaims`, tag each drafted claim that cites any id in an audited paper's set with that paper's `redFlags` (attach only; no cap, no drop).
- `ThreadFindings` gains `critiques: MethodologicalCritique[]`, returned from the loop.

### `produceResearchSection.ts`

- Pass `verifierModel` into `runResearcher`.
- Attach `findings.critiques` to the returned `Section`.
- Supported claims keep their `redFlags` through grounding and verification (those steps do not strip them).

### `synthesize.ts` writer

- The findings digest annotates each claim that carries a moderate/high flag with its audit note (`(AUDIT: high surrogate_endpoint - <explanation>)`); low flags are not surfaced.
- The writer system prompt instructs: when citing a finding that carries an audit note, state the finding and append its caveat in the same sentence; never drop a finding for a methodological flag.

### CLI (`apps/cli/src/run.ts`)

- `formatTrace` renders `methodological_critique`: `⚖ skeptic [<evidenceId>]: <studyDesign> - <biasRisk>:<category>; ...` or `- no flags`.

## Out of scope

- Full-text-level audit (v1 audits the deep-read paper's primary passage; richer multi-section audit is a fast-follow).
- Probability-of-success scoring, modality-fit, translational strategy (later VP-layer slices).
- Changing the RAG formula or the grounding/verification gates.

## Testing

- **Contracts:** Zod validation fails on invalid `studyDesign`, invalid `biasRisk`, invalid `category`, and empty `explanation`; a valid critique parses; `Claim` accepts optional `redFlags`; `Section` accepts optional `critiques`.
- **skepticAudit:** with a mock model returning an audit, `runSkepticAudit` returns a critique whose `evidenceId` is the paper's id and whose flags pass through; the system prompt scrutinizes design/dropout/endpoint/blinding.
- **researcher integration:** when the audit returns a high flag, a claim citing that paper carries the `redFlags` and its confidence is unchanged (no cap), and the claim survives; `methodological_critique` is emitted; an audit failure does not abort the loop.
- **synthesize:** a claim carrying a high flag puts its audit note into the writer prompt; a low flag does not.
- Full repo suite green.

## Success criteria

A local CDCP1 smoke shows `⚖ skeptic` audit lines after deep-reads, claims carrying red flags where the design warrants, and (where moderate/high flags exist) the final dossier prose stating the finding together with its methodological caveat rather than dropping it.
