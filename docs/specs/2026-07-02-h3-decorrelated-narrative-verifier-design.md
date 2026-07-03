# Decorrelated Narrative Verifier Design (H3)

**Status:** Approved (design calls confirmed). Ready for implementation plan.
**Parent:** [Patent Specialist Hardening Roadmap](./2026-07-02-patent-specialist-hardening-roadmap.md).
**Date:** 2026-07-02.

## Purpose

`synthesizeCompetitiveIP` ships narrative claims that are grounded only structurally (citations filtered to real SEQ-IDs/accessions). That stops fabricated identifiers but not unsupported inference ("these two are the same antibody family", "this overlap is material"). This slice adds a verifier that re-checks each narrative claim against the workup facts on a DECORRELATED model family, so the check does not rubber-stamp the synthesizer's own blind spots.

## Decorrelation rule (confirmed)

Verify on the opposite configured backend from the one that synthesized (Claude <-> Ollama). Same-family verification is an anti-pattern - models validate their own latent biases.

Honest fallback: when the opposite backend is not available (e.g. only one API key configured), degrade to a same-family different-weight model (for example the `verifier` role model, which differs from the `writer` model) and emit a visible `decorrelated: false` flag. Never silently skip, never silently pretend a same-family check is decorrelated.

## Components (core, new file `narrativeVerify.ts`)

### `makeDecorrelatedVerifier(primary, opts?) => { model, modelId, decorrelated }`

```ts
function makeDecorrelatedVerifier(
  primary: Backend = currentBackend(),
  opts?: { anthropicKeyPresent?: boolean },
): { model: StructuredModel; modelId: string; decorrelated: boolean }
```

- `opposite = primary === 'anthropic' ? 'ollama' : 'anthropic'`.
- Availability: Anthropic requires a key (`opts.anthropicKeyPresent ?? Boolean(process.env.ANTHROPIC_API_KEY)`); Ollama is local and assumed available.
- If the opposite backend is available: `model` = the opposite backend's model, `modelId` = `routerFor(opposite).verifier`, `decorrelated: true`.
- Else (fallback): `model` = the primary backend's model, `modelId` = `routerFor(primary).verifier` (a different weight than the writer), `decorrelated: false`.
- `opts.anthropicKeyPresent` is injectable so the selection is unit-testable without touching real env.

### `verifyNarrative(ip, workup, verifier) => CompetitiveIP`

Adapts the existing verifier spine (`verifyClaims` in `verifier.ts`) to the workup. For each `ip.points[i]`:
- Build the evidence text from the workup facts the point cites (SEQ-IDs -> construct region residues/blast/species; accessions -> competitor hits), the same facts `synthesizeCompetitiveIP` was given.
- Ask the verifier model (an adversarial reviewer prompt, reused from `verifier.ts`) whether the evidence SUPPORTS the point: `supported` | `unsupported` | `overreach`.
- Attach the verdict to the point.
- On any model error, that point's verdict is `unverified` (never throws).

Returns an enriched `CompetitiveIP` carrying `decorrelated` and `verified` (false if the verifier model errored on every point). Unsupported/overreach points are FLAGGED (kept with their verdict), not silently dropped - the rejection must be transparent so the reader sees what the verifier rejected.

## Type additions (in `patentWorkup.ts`)

```ts
type ClaimVerdict = 'supported' | 'unsupported' | 'overreach' | 'unverified';
interface IpPoint { point: string; citations: string[]; verdict?: ClaimVerdict }   // verdict added
interface CompetitiveIP {
  summary: string;
  points: IpPoint[];
  decorrelated?: boolean;   // was the verifier a genuinely decorrelated model
  verified?: boolean;       // did the verifier run (false if it errored on everything)
}
```

## Wiring (`apps/cli/src/patentWorkup.ts`)

In `runPatentWorkup`, after `synthesizeCompetitiveIP`: build the verifier via `makeDecorrelatedVerifier()` and run `verifyNarrative(workup.narrative, workup, verifier)`; assign the enriched narrative back. Injectable verifier dep for tests. The `decorrelated: false` flag surfaces in the printed workup so an operator sees when verification ran same-family.

## Error handling

`verifyNarrative` never throws: a verifier-model failure yields per-point `unverified` verdicts and `verified: false`. The workup still ships (the narrative is present, just unverified). `makeDecorrelatedVerifier` never throws (it only selects; construction of `AnthropicModel` is guarded by the key check, `OllamaModel` construction is inert).

## Testing

- `makeDecorrelatedVerifier`: primary ollama + `anthropicKeyPresent: true` -> decorrelated true, modelId = anthropic verifier; primary ollama + `anthropicKeyPresent: false` -> decorrelated false, modelId = ollama verifier; primary anthropic -> opposite ollama available -> decorrelated true, modelId = ollama verifier.
- `verifyNarrative`: a mock verifier returning `supported`/`overreach` per point attaches those verdicts; a point the verifier calls `overreach` is kept and flagged (not dropped); a throwing verifier model yields all `unverified` and `verified: false` without throwing.
- CLI wiring: the workup's narrative carries verdicts and the `decorrelated` flag.

## Out of scope

- Re-writing the narrative to fix an overreach (we flag, not repair).
- Verifying the deterministic facts (constructs, graph) - those are already computed, not LLM claims.
