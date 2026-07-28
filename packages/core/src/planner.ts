import { z } from 'zod';
import type { TraceEvent } from '@mrsirquanzo/sonny-shared';
import { MODEL_ROUTER, type StructuredModel } from './model.js';
import type { ResearchContext, ThreadBrief } from './researcher.js';
import { RESEARCH_ROSTER } from './researchRoster.js';
import { resolveModalityLens } from './modalityLens.js';
import { canonicalModalityOf } from './modalityCanon.js';
import {
  strategyFingerprint, sha256CanonicalJson, q1HypothesesFor, isScopeLegalForAxis,
  type CanonicalModality, type SectionScope, type SpecialistExecutionContext, type TargetIdentity,
} from '@mrsirquanzo/sonny-shared';

export const CANONICAL_CATEGORIES = [
  { id: 'target_biology', role: 'Establish the target biology and target-level evidence relevant to the modality.' },
  { id: 'moa_pathway', role: 'Assess whether the mechanism and pathway biology support the modality.' },
  { id: 'disease_indications', role: 'Evaluate indication fit, patient selection, and the therapeutic window.' },
  { id: 'clinical_landscape', role: 'Map clinical and translational precedent for the target and modality.' },
  { id: 'competitive_ip', role: 'Assess competition, differentiation, intellectual property, and freedom to operate.' },
  { id: 'modality_developability', role: 'Evaluate modality-specific safety, tractability, and developability risks.' },
] as const;

const InferModalitySchema = z.object({
  modality: z.string(),
  rationale: z.string(),
});

export async function inferModality(
  target: string,
  model: StructuredModel,
): Promise<{ modality: string; rationale: string }> {
  try {
    const inferred = await model.generateStructured({
      system: 'Given a molecular target, name the single MOST plausible therapeutic modality to pursue it, based on target biology - e.g. cell-surface / secreted -> "ADC" or "antibody"; intracellular enzyme / kinase / GTPase -> "small molecule"; E3-recruitable intracellular -> "small molecule degrader (PROTAC)"; RNA-level -> "siRNA/ASO". Return one concise modality phrase plus a one-sentence rationale. Prefer "small molecule" for classic intracellular targets; prefer "ADC"/"antibody" only for accessible cell-surface targets.',
      prompt: `TARGET: ${target}`,
      schema: InferModalitySchema,
      model: MODEL_ROUTER.lead,
    });
    return InferModalitySchema.parse(inferred);
  } catch {
    // MUST NOT default to antibody: that reintroduces the wrong-rubric bug in
    // the failure branch, and makes the generic fallback lens unreachable.
    return { modality: 'unknown', rationale: 'inference failed; modality unresolved' };
  }
}

export function isAntibodyModality(modality?: string): boolean {
  const normalized = modality?.trim().toLowerCase();
  if (!normalized) return true;
  return /\b(?:adc|antibod(?:y|ies)|antibody[ -]drug conjugates?|immunoconjugates?)\b/.test(normalized);
}

/**
 * Deterministic rubric builder. Makes NO model call.
 *
 * This previously asked a model to "Rewrite every kept title, objective, and
 * promptHint", permitted dropping categories, adding a seventh specialist, and
 * clamped to 7. Two runs of the same target were therefore structurally
 * incomparable, which defeats the reproducibility and evaluability the fixed
 * spine exists to provide.
 *
 * All six axes always instantiate. Modality conditioning happens through the
 * lens injected into Q2 and Q6, not by regenerating the rubric.
 */
export function composeRoster(opts: {
  target: string;
  context?: ResearchContext;
  /** Optional. Derived from `context.modality` when omitted. */
  modality?: CanonicalModality;
  emit: (e: TraceEvent) => void;
  /** Base rubric to condition. Defaults to the canonical six-axis spine. */
  baseRoster?: ThreadBrief[];
}): ThreadBrief[] {
  const modality = opts.modality ?? canonicalModalityOf(opts.context?.modality);
  const lens = resolveModalityLens({ modality });
  // Provenance is keyed by strategy fingerprint, which is present even on a
  // single-strategy run. The variant LABEL is presentation-only and is omitted
  // when there is only one strategy.
  const strategy = (opts.context as { strategy?: { interventions?: unknown[] } } | undefined)?.strategy;
  const intervention = strategy?.interventions?.[0];
  const fingerprint = intervention
    ? strategyFingerprint(intervention as never)
    : sha256CanonicalJson({ target: opts.target, modality });
  // Q1 is keyed by HYPOTHESIS, not by strategy: it is reused across every
  // strategy sharing a (target, role, intent) triple, so it belongs to no
  // single strategy. Q2/Q4/Q5/Q6 are strategy-scoped. Q3 is shared - the one
  // comparative output spans strategies.
  const hypotheses = intervention ? q1HypothesesFor(intervention as never) : [];
  const q1Hypothesis = hypotheses[0];
  // Without a resolved strategy there is no legal scope to assign: Q1 needs a
  // hypothesis and the rest need a fingerprint derived from an intervention.
  // Omit scope rather than fabricate one, so back-compat callers are unchanged
  // and an illegal (axis, scope) pair is never constructed.
  const scopeFor = (id: string): SectionScope | undefined => {
    if (!intervention) return undefined;
    if (id === 'target_biology') {
      return q1Hypothesis
        ? { kind: 'q1_hypothesis', q1HypothesisKey: q1Hypothesis.key, relatedStrategyFingerprints: [fingerprint] }
        : undefined;
    }
    if (id === 'disease_indications') return { kind: 'shared' };
    return { kind: 'strategy', strategyFingerprint: fingerprint };
  };
  const contextFor = (scope: SectionScope): SpecialistExecutionContext => {
    switch (scope.kind) {
      case 'q1_hypothesis':
        return { kind: 'q1_hypothesis', hypothesis: q1Hypothesis!, relatedStrategyFingerprints: scope.relatedStrategyFingerprints };
      case 'shared':
        return { kind: 'shared', queryScope: { subjectTargets: subjectTargetsOf(intervention), rawPrompt: opts.target } };
      case 'strategy':
        return { kind: 'strategy', strategy: strategy as never, strategyFingerprint: scope.strategyFingerprint };
    }
  };

  const roster = (opts.baseRoster ?? RESEARCH_ROSTER).map((brief) => {
    const withLensApplied = brief.id === 'moa_pathway'
      ? withLens(brief, lens.resolvedQ2Lens)
      : brief.id === 'modality_developability'
        ? withLens(brief, lens.resolvedQ6Lens)
        : brief;
    const scope = scopeFor(brief.id);
    if (!scope) return withLensApplied;
    if (!isScopeLegalForAxis(brief.id as never, scope)) {
      throw new Error(`axis ${brief.id} may not use scope ${scope.kind}`);
    }
    return { ...withLensApplied, scope, context: contextFor(scope) };
  });
  try {
    opts.emit({
      type: 'plan_composed',
      modality,
      specialists: roster.map((b) => ({ id: b.id, title: b.title, weight: 1 })),
      // Per-strategy lens provenance. Required for reproducibility: without the
      // resolved lists, rerunning after a modalityLens.ts change shifts outputs
      // with nothing to show why.
      resolvedStrategyLenses: [{
        strategyFingerprint: fingerprint,
        modalityLensKey: lens.modalityLensKey,
        modalityLensVersion: lens.modalityLensVersion,
        resolvedQ2Lens: lens.resolvedQ2Lens,
        resolvedQ6Lens: lens.resolvedQ6Lens,
      }],
      rationale: `deterministic six-axis spine; ${modality} lens v${lens.modalityLensVersion}`,
    });
  } catch {
    // Trace sinks must not make roster composition fail.
  }
  return roster;
}

/** Inject lens items into a brief's promptHint, ahead of its BOUNDARY clause. */
function withLens(brief: ThreadBrief, lensItems: string[]): ThreadBrief {
  if (lensItems.length === 0) return brief;
  const marker = 'BOUNDARY:';
  const idx = brief.promptHint.indexOf(marker);
  const injected = `Evaluate the following modality-specific factors: ${lensItems.join('; ')}. `;
  return {
    ...brief,
    promptHint: idx === -1
      ? `${brief.promptHint} ${injected}`
      : `${brief.promptHint.slice(0, idx)}${injected}${brief.promptHint.slice(idx)}`,
  };
}

/** Targets the disease question is about. Never inferred from array order. */
function subjectTargetsOf(intervention: unknown): TargetIdentity[] {
  const iv = intervention as { engagements?: Array<{ target: TargetIdentity }>; subjectEngagementIndexes?: number[] } | undefined;
  const engagements = iv?.engagements ?? [];
  if (engagements.length === 0) return [{ kind: 'other', canonicalName: 'unspecified' }];
  const idx = iv?.subjectEngagementIndexes;
  return (idx?.length ? idx.map((i) => engagements[i]).filter(Boolean) : engagements).map((e) => e.target);
}
