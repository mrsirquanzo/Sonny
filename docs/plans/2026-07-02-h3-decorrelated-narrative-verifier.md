# Decorrelated Narrative Verifier Implementation Plan (H3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify each competitive-IP narrative claim against the workup facts on a decorrelated model family, flagging (not dropping) unsupported/overreach claims, with an honest `decorrelated: false` fallback.

**Architecture:** A new `packages/core/src/narrativeVerify.ts` with `makeDecorrelatedVerifier` (opposite-backend selection with fallback) and `verifyNarrative` (adapts the `verifyClaims` spine to workup facts). `CompetitiveIP` gains per-point verdicts and `decorrelated`/`verified` flags. The CLI wires it after synthesis.

**Tech Stack:** TypeScript ESM, Vitest, Zod. Test runner: `pnpm --filter @sonny/<pkg> test`.

**Spec:** [docs/specs/2026-07-02-h3-decorrelated-narrative-verifier-design.md](../specs/2026-07-02-h3-decorrelated-narrative-verifier-design.md).

## Global Constraints

- Never use the em dash; use a plain hyphen.
- Never auto-add a commit co-author.
- ESM relative imports use the `.js` extension; all imports at the top.
- `verifyNarrative` and `makeDecorrelatedVerifier` NEVER throw; a verifier-model failure yields per-point `unverified` verdicts and `verified: false`.
- Verify on the OPPOSITE backend; fall back to same-family with a visible `decorrelated: false` flag - never silently skip.
- Unsupported/overreach points are flagged (kept with their verdict), never silently dropped.
- Touch only the files named in each task.

## File Structure

- Modify: `packages/core/src/patentWorkup.ts` - add `ClaimVerdict`, extend `IpPoint`/`CompetitiveIP`.
- Create: `packages/core/src/narrativeVerify.ts` + test - `makeDecorrelatedVerifier`, `verifyNarrative`.
- Modify: `packages/core/src/index.ts` - export the verifier API.
- Modify: `apps/cli/src/patentWorkup.ts` + test - wire verification into `runPatentWorkup`.

---

### Task 1: `makeDecorrelatedVerifier` + `verifyNarrative`

**Files:**
- Modify: `packages/core/src/patentWorkup.ts`
- Create: `packages/core/src/narrativeVerify.ts`
- Test: `packages/core/src/narrativeVerify.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `StructuredModel`, `Backend`, `currentBackend`, `routerFor`, `AnthropicModel`, `OllamaModel` from `./model.js`; `VerdictStatusSchema` from `@sonny/shared`; `CompetitiveIP`, `IpPoint`, `PatentWorkup`, `ClaimVerdict` from `./patentWorkup.js`.
- Produces: `interface Verifier { model, modelId, decorrelated }`; `makeDecorrelatedVerifier(primary?, opts?)`; `verifyNarrative(ip, workup, verifier)`.

- [ ] **Step 1: Extend the CompetitiveIP types**

In `packages/core/src/patentWorkup.ts`, replace the `IpPoint` and `CompetitiveIP` interfaces:

```ts
export type ClaimVerdict = 'supported' | 'unsupported' | 'overreach' | 'unverified';
export interface IpPoint { point: string; citations: string[]; verdict?: ClaimVerdict }
export interface CompetitiveIP { summary: string; points: IpPoint[]; decorrelated?: boolean; verified?: boolean }
```

- [ ] **Step 2: Write the failing tests**

Create `packages/core/src/narrativeVerify.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makeDecorrelatedVerifier, verifyNarrative } from './narrativeVerify.js';
import type { StructuredModel } from './model.js';
import type { CompetitiveIP, PatentWorkup } from './patentWorkup.js';

const workup: PatentWorkup = {
  patentNumber: 'US10123456',
  patent: { input: 'US10123456', found: true, applicants: ['ACME'], inventors: [], ipc: [], family: [] },
  constructs: [{ name: 'Ab1', regions: [{ regionLabel: 'VH', seqId: 1, residues: 'EVQL' }], species: { classification: 'human-like', evidence: '' } }],
  ungrouped: [], narrative: { summary: '', points: [] }, graph: [],
};

const ip: CompetitiveIP = { summary: 'ACME owns a human-like antibody.', points: [
  { point: 'VH is disclosed as SEQ 1', citations: ['SEQ:1'] },
  { point: 'This is the market-leading antibody', citations: ['SEQ:1'] },
] };

// Inject model factories so the selector never constructs a real AnthropicModel (which throws without a key).
const stub: StructuredModel = { async generateStructured() { return {} as never; } };
const factories = { anthropic: () => stub, ollama: () => stub };

describe('makeDecorrelatedVerifier', () => {
  it('picks the opposite backend when available (ollama primary + anthropic key)', () => {
    const v = makeDecorrelatedVerifier('ollama', { anthropicKeyPresent: true, ...factories });
    expect(v.decorrelated).toBe(true);
    expect(v.modelId).toBe('claude-sonnet-4-6'); // anthropic verifier
  });
  it('falls back to same-family with decorrelated:false when the opposite is unavailable', () => {
    const v = makeDecorrelatedVerifier('ollama', { anthropicKeyPresent: false, ...factories });
    expect(v.decorrelated).toBe(false);
    expect(v.modelId).toBe('llama3.1:8b'); // ollama verifier (same family, different weight)
  });
  it('uses ollama (assumed available) as the opposite of anthropic', () => {
    const v = makeDecorrelatedVerifier('anthropic', { anthropicKeyPresent: true, ...factories });
    expect(v.decorrelated).toBe(true);
    expect(v.modelId).toBe('llama3.1:8b');
  });
});

describe('verifyNarrative', () => {
  it('attaches per-point verdicts and keeps (flags) an overreach point', async () => {
    const model: StructuredModel = {
      async generateStructured(opts: { prompt: string }) {
        return { status: opts.prompt.includes('market-leading') ? 'overreach' : 'supported', rationale: '' } as never;
      },
    };
    const out = await verifyNarrative(ip, workup, { model, modelId: 'x', decorrelated: true });
    expect(out.decorrelated).toBe(true);
    expect(out.verified).toBe(true);
    expect(out.points[0].verdict).toBe('supported');
    expect(out.points[1].verdict).toBe('overreach');   // kept and flagged, not dropped
    expect(out.points).toHaveLength(2);
  });

  it('degrades to unverified without throwing when the verifier model errors', async () => {
    const model: StructuredModel = { async generateStructured() { throw new Error('down'); } };
    const out = await verifyNarrative(ip, workup, { model, modelId: 'x', decorrelated: true });
    expect(out.verified).toBe(false);
    expect(out.points.every((p) => p.verdict === 'unverified')).toBe(true);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/core test -- narrativeVerify`
Expected: FAIL - `narrativeVerify.js` does not exist yet.

- [ ] **Step 4: Implement the verifier**

Create `packages/core/src/narrativeVerify.ts`:

```ts
import { z } from 'zod';
import { VerdictStatusSchema } from '@sonny/shared';
import type { StructuredModel, Backend } from './model.js';
import { currentBackend, routerFor, AnthropicModel, OllamaModel } from './model.js';
import type { CompetitiveIP, IpPoint, PatentWorkup, ClaimVerdict } from './patentWorkup.js';

export interface Verifier { model: StructuredModel; modelId: string; decorrelated: boolean }

const VerifySchema = z.object({ status: VerdictStatusSchema, rationale: z.string() });

const SYSTEM =
  'You are an adversarial reviewer. Decide whether the EVIDENCE supports the CLAIM. "supported": the evidence directly backs the claim. "unsupported": the evidence does not back it. "overreach": the claim asserts more than the evidence shows (materiality, market claims, "same family"). Judge ONLY from the provided evidence. Be strict.';

export function makeDecorrelatedVerifier(
  primary: Backend = currentBackend(),
  opts: { anthropicKeyPresent?: boolean; anthropic?: () => StructuredModel; ollama?: () => StructuredModel } = {},
): Verifier {
  const opposite: Backend = primary === 'anthropic' ? 'ollama' : 'anthropic';
  const anthropicKeyPresent = opts.anthropicKeyPresent ?? Boolean(process.env.ANTHROPIC_API_KEY);
  // Factories are injectable so tests never construct a real AnthropicModel (which throws without a key).
  const anthropic = opts.anthropic ?? (() => new AnthropicModel());
  const ollama = opts.ollama ?? (() => new OllamaModel());
  const oppositeAvailable = opposite === 'anthropic' ? anthropicKeyPresent : true; // ollama is local
  if (oppositeAvailable) {
    return {
      model: opposite === 'ollama' ? ollama() : anthropic(),
      modelId: routerFor(opposite).verifier,
      decorrelated: true,
    };
  }
  return {
    model: primary === 'ollama' ? ollama() : anthropic(),
    modelId: routerFor(primary).verifier,
    decorrelated: false,
  };
}

function factIndex(workup: PatentWorkup): Map<string, string> {
  const idx = new Map<string, string>();
  for (const c of workup.constructs) {
    for (const r of c.regions) {
      const bits = [`${r.regionLabel} SEQ:${r.seqId} in ${c.name} (species ${c.species.classification})`];
      if (r.cdrConfirmation) bits.push(`CDR ${r.cdrConfirmation}`);
      if (r.blast) bits.push(`nr top hit ${r.blast.accession} ${r.blast.percentIdentity}% mismatches=${r.blast.mismatchCount}`);
      idx.set(`SEQ:${r.seqId}`, bits.join('; '));
      for (const h of r.patentMatches ?? []) {
        idx.set(h.accession, `competitor patent ${h.accession} ${h.percentIdentity}% mismatches=${h.mismatchCount}`);
      }
    }
  }
  idx.set('patent', `patent ${workup.patentNumber ?? 'unknown'}; applicants ${workup.patent.applicants.join(', ') || 'unknown'}`);
  return idx;
}

export async function verifyNarrative(
  ip: CompetitiveIP,
  workup: PatentWorkup,
  verifier: Verifier,
): Promise<CompetitiveIP> {
  const idx = factIndex(workup);
  const points: IpPoint[] = [];
  let anyVerified = false;
  for (const p of ip.points) {
    const evidence = p.citations.map((c) => idx.get(c) ?? c).join('\n') || '(no cited evidence)';
    let verdict: ClaimVerdict = 'unverified';
    try {
      const r = await verifier.model.generateStructured({
        system: SYSTEM,
        prompt: `CLAIM:\n${p.point}\n\nEVIDENCE:\n${evidence}`,
        schema: VerifySchema,
        model: verifier.modelId,
      });
      verdict = r.status;
      anyVerified = true;
    } catch {
      verdict = 'unverified';
    }
    points.push({ ...p, verdict });
  }
  return { ...ip, points, decorrelated: verifier.decorrelated, verified: anyVerified };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/core test -- narrativeVerify`
Expected: PASS.

- [ ] **Step 6: Export from the core index**

In `packages/core/src/index.ts`, add:

```ts
export { makeDecorrelatedVerifier, verifyNarrative, type Verifier } from './narrativeVerify.js';
export { type ClaimVerdict } from './patentWorkup.js';
```

- [ ] **Step 7: Run the full core suite and commit**

Run: `pnpm --filter @sonny/core test`
Expected: PASS (the `verdict`/`decorrelated`/`verified` fields are optional; existing `CompetitiveIP` literals are unaffected).

```bash
git add packages/core/src/patentWorkup.ts packages/core/src/narrativeVerify.ts packages/core/src/narrativeVerify.test.ts packages/core/src/index.ts
git commit -m "feat(core): add decorrelated narrative verifier with honest same-family fallback"
```

---

### Task 2: Wire verification into `runPatentWorkup`

**Files:**
- Modify: `apps/cli/src/patentWorkup.ts`
- Test: `apps/cli/src/patentWorkup.test.ts`

**Interfaces:**
- Consumes: `makeDecorrelatedVerifier`, `verifyNarrative`, `Verifier` from `@sonny/core`.
- Produces: `WorkupDeps` gains an optional `verifier?: Verifier`; `runPatentWorkup` verifies the narrative after synthesis.

- [ ] **Step 1: Write the failing test**

Append to `apps/cli/src/patentWorkup.test.ts`:

```ts
import type { Verifier } from '@sonny/core';

describe('runPatentWorkup narrative verification', () => {
  it('verifies the narrative and carries verdicts + the decorrelated flag', async () => {
    const verifier: Verifier = {
      model: { async generateStructured() { return { status: 'overreach', rationale: '' } as never; } },
      modelId: 'x', decorrelated: false,
    };
    // reuse the happy-path model + ingest from the existing test in this file
    const out = await runPatentWorkup('/x.pdf', {
      ingest: async () => ({ markdown: 'Patent US 10,123,456 B2\nClaims\nSEQ ID NO: 1\nEVQLVESGGGLVQPGGSLRLSCAASGFTFSSYAMSWVRQAPGKGLEWVS\n', status: 'ok' as const }),
      model: { async generateStructured(opts: { system: string }) {
        if (opts.system.includes('extract')) return { associations: [{ regionLabel: 'VH', seqId: 1 }] } as never;
        if (opts.system.includes('group')) return { constructs: [{ name: 'Ab1', members: [{ regionLabel: 'VH', seqId: 1 }] }] } as never;
        return { summary: 'ACME.', points: [{ point: 'market leader', citations: ['SEQ:1'] }] } as never;
      } },
      reconcileDeps: {
        blast: async () => [],
        anarci: async () => ({ overallStatus: 'confirmed', domains: [{ chain: 'H', species: 'homo_sapiens', germline: { v: '', j: '' }, numberedRegions: {} }], regionChecks: [], speciesSummary: [] }),
        epo: async () => ({ input: 'US10123456', found: true, applicants: ['ACME'], inventors: [], ipc: [], family: [] }),
      },
      verifier,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.workup.narrative.decorrelated).toBe(false);
      expect(out.workup.narrative.points[0]?.verdict).toBe('overreach');
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @sonny/cli test -- patentWorkup`
Expected: FAIL - `verifier` is not a recognized dep / verification not wired.

- [ ] **Step 3: Wire verification in**

In `apps/cli/src/patentWorkup.ts`, add to the imports:

```ts
import { makeDecorrelatedVerifier, verifyNarrative } from '@sonny/core';
import type { Verifier } from '@sonny/core';
```

Add `verifier?: Verifier;` to the `WorkupDeps` interface. Then in `runPatentWorkup`, after `workup.narrative = await synthesizeCompetitiveIP(workup, model);` and before `workup.graph = graphRelationships(workup);`, add:

```ts
  const verifier = deps.verifier ?? makeDecorrelatedVerifier();
  workup.narrative = await verifyNarrative(workup.narrative, workup, verifier);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/cli test -- patentWorkup`
Expected: PASS.

- [ ] **Step 5: Run the full CLI suite and commit**

Run: `pnpm --filter @sonny/cli test`
Expected: PASS.

```bash
git add apps/cli/src/patentWorkup.ts apps/cli/src/patentWorkup.test.ts
git commit -m "feat(cli): verify the competitive-IP narrative on a decorrelated model in the workup"
```

---

## Notes for the controller

- The `IpPoint.verdict` / `CompetitiveIP.decorrelated` / `verified` fields are optional, so existing `CompetitiveIP` literals do not break.
- A real decorrelated run needs the opposite backend reachable (Ollama running, or `ANTHROPIC_API_KEY` set); a manual smoke confirms verdicts differ from the synthesizer on a genuine overreach.
- Out of scope: rewriting an overreaching narrative (flag, not repair); H4 CDR-level matching (separate slice).