import {
  SpecialistConclusionSchema,
  type Claim,
  type SpecialistConclusion,
  type TraceEvent,
  type ConclusionSupport,
} from '@mrsirquanzo/sonny-shared';
import type { EvidenceStore } from '../evidenceStore.js';
import type { RetrievalAuditStore } from '@mrsirquanzo/sonny-shared';
import { resolveSupport } from './support.js';
import { rewriteAllSupport } from './rewriteSupport.js';
import { absenceCoverageHolds } from './coverage.js';

/**
 * Deterministic validation and degradation. No model call.
 *
 * A conclusion is drafted from claims that survived verification, but two things
 * can still be wrong by the time it is assembled: its supporting claims may all
 * have been rejected, or it may assert an absence without the retrieval coverage
 * that alone can ground one. Both degrade to `insufficient_evidence` at
 * `confidence: 'low'` rather than shipping a confident answer nothing supports.
 *
 * Degradation is deliberately lossy in one direction only: it can weaken a
 * conclusion, never strengthen one.
 */
export function validateAndDegrade(opts: {
  conclusion: SpecialistConclusion;
  verifiedClaims: readonly Claim[];
  deterministicClaims?: readonly Claim[];
  store: EvidenceStore;
  auditStore: RetrievalAuditStore;
  /**
   * Which section this conclusion answers. Absence is a claim about THIS
   * question, so only audits recorded for this section may support it.
   * Defaults to the axis, which is correct for a single-strategy run where one
   * section exists per axis; strategy-scoped threads MUST pass it explicitly or
   * two Q4 threads on the same axis would share each other's coverage.
   */
  sectionKey?: string;
  emit?: (e: TraceEvent) => void;
}): SpecialistConclusion {
  const { conclusion, verifiedClaims, deterministicClaims = [], store, auditStore, emit } = opts;
  const sectionKey = opts.sectionKey ?? conclusion.axis;

  const rebuilt = withResolvedSupport(conclusion, { verifiedClaims, deterministicClaims, store, emit });

  const coverage = absenceCoverageHolds({ conclusion: rebuilt.conclusion, sectionKey, auditStore });
  if (coverage.droppedAuditIds.length) {
    emit?.({ type: 'error', message: `conclusion ${conclusion.axis}: dropped unresolvable retrievalAuditIds ${coverage.droppedAuditIds.join(', ')}` });
  }
  const pruned = withAuditIds(rebuilt.conclusion, coverage.resolvedAuditIds);

  if (rebuilt.allSupportLost) {
    emit?.({ type: 'error', message: `conclusion ${conclusion.axis}: all supporting claims failed verification, degrading` });
    return degrade(pruned, 'every supporting claim failed verification');
  }

  if (!coverage.adequate) {
    emit?.({ type: 'error', message: `conclusion ${conclusion.axis}: ${coverage.reason}, degrading` });
    return degrade(pruned, coverage.reason ?? 'absence lacks retrieval coverage');
  }

  // Parse last: degradation must produce a schema-valid conclusion, and a
  // malformed one that slipped through drafting must not ship either.
  return SpecialistConclusionSchema.parse(pruned);
}

/** Replace `retrievalAuditIds` with the ids that actually resolved. */
function withAuditIds(c: SpecialistConclusion, auditIds: string[]): SpecialistConclusion {
  if (!('assessment' in c)) return c;
  const support = c.assessment.support;
  if (support.retrievalAuditIds === undefined) return c;
  return { ...c, assessment: { ...c.assessment, support: { ...support, retrievalAuditIds: auditIds } } } as SpecialistConclusion;
}

export { deriveEvidenceIds } from './support.js';


function withResolvedSupport(
  c: SpecialistConclusion,
  ctx: { verifiedClaims: readonly Claim[]; deterministicClaims: readonly Claim[]; store: EvidenceStore; emit?: (e: TraceEvent) => void },
): { conclusion: SpecialistConclusion; allSupportLost: boolean } {
  const resolve = (support: Parameters<typeof resolveSupport>[0]['support']) =>
    resolveSupport({ support, ...ctx });

  switch (c.axis) {
    case 'target_biology': {
      const resolved = c.assessments.map((a) => resolve(a.support));
      return {
        conclusion: { ...c, assessments: c.assessments.map((a, i) => ({ ...a, support: resolved[i].support })) },
        // Q1 holds one assessment per disease context. It is only fully
        // unsupported when EVERY context lost its support; one context losing
        // its evidence must not erase the others.
        allSupportLost: resolved.length > 0 && resolved.every((r) => r.allSupportLost),
      };
    }
    case 'disease_indications': {
      // Support is nested two levels down (assessments[].rankedStrategies[]),
      // so walk the tree rather than reaching for a fixed path.
      const before: ConclusionSupport[] = [];
      const after: ConclusionSupport[] = [];
      const rewritten = rewriteAllSupport(c, [...ctx.verifiedClaims, ...ctx.deterministicClaims], ctx.store,
        (b, a) => { before.push(b); after.push(a); });
      return {
        conclusion: rewritten,
        // Any ranked strategy that cited claims and kept none is unsupported.
        allSupportLost: before.some((b, i) => b.supportingClaimIds.length > 0 && after[i].supportingClaimIds.length === 0),
      };
    }
    default: {
      const r = resolve(c.assessment.support);
      return {
        conclusion: { ...c, assessment: { ...c.assessment, support: r.support } } as SpecialistConclusion,
        allSupportLost: r.allSupportLost,
      };
    }
  }
}

/**
 * Q3's two modes carry support differently: the strategy overlay's assessments
 * each hold their own `support`, while a comparative assessment ranks
 * strategies and need not. Guarded rather than cast - a comparative Q3 has no
 * support to lose, and treating its absence as "all support lost" would degrade
 * a perfectly valid conclusion.
 */
function supportOf(c: Extract<SpecialistConclusion, { axis: 'disease_indications' }>) {
  const first = c.conclusion.assessments[0] as { support?: { supportingClaimIds: string[]; evidenceIds: string[] } } | undefined;
  return first?.support ?? { supportingClaimIds: [], evidenceIds: [] };
}

/** Rewrite a conclusion into its axis's `insufficient_evidence` shape. */
function degrade(c: SpecialistConclusion, gap: string): SpecialistConclusion {
  switch (c.axis) {
    case 'target_biology':
      return SpecialistConclusionSchema.parse({
        axis: c.axis,
        assessments: c.assessments.map((a) => ({ ...a, validity: 'insufficient_evidence', confidence: 'low' })),
      });
    case 'moa_pathway':
      // The discriminated shape does the enforcing: an insufficient Q2 has no
      // field in which to keep a `mechanisticBottleneck`, so the bottleneck
      // cannot survive degradation as a leftover confident assertion.
      return SpecialistConclusionSchema.parse({
        axis: c.axis,
        assessment: {
          modalityFit: 'insufficient_evidence', confidence: 'low',
          evidenceGap: gap, support: c.assessment.support,
        },
      });
    case 'disease_indications':
      // Q3 carries support per ranked strategy, so degrade at that granularity.
      // Emptying `assessments` would delete the disease contexts themselves and
      // lose the record that they were considered at all.
      return SpecialistConclusionSchema.parse({
        axis: c.axis,
        conclusion: {
          ...c.conclusion,
          assessments: c.conclusion.assessments.map((a) => ({
            ...a,
            ...('rankedStrategies' in a ? {
              rankedStrategies: a.rankedStrategies.map((s) =>
                s.support.supportingClaimIds.length === 0
                  ? { ...s, opportunity: 'insufficient_evidence', confidence: 'low' }
                  : s),
            } : {}),
          })),
        },
      });
    case 'clinical_landscape':
      return SpecialistConclusionSchema.parse({
        axis: c.axis,
        assessment: { precedent: 'insufficient_evidence', confidence: 'low', support: c.assessment.support },
      });
    case 'competitive_ip':
      return SpecialistConclusionSchema.parse({
        axis: c.axis,
        assessment: {
          landscapeDensity: 'insufficient_evidence', differentiationPotential: 'insufficient_evidence',
          ipSignal: 'unknown', confidence: 'low', support: c.assessment.support,
        },
      });
    case 'modality_developability':
      // Liabilities and domain assessments are RETAINED. They record analysis
      // that was performed; dropping them would make "we looked and found
      // nothing" indistinguishable from "we never looked", which is the exact
      // confusion RiskDomainAssessment exists to prevent.
      return SpecialistConclusionSchema.parse({
        axis: c.axis,
        assessment: {
          overallDevelopmentRisk: 'insufficient_evidence',
          liabilities: c.assessment.liabilities,
          domainAssessments: c.assessment.domainAssessments,
          evidenceGap: gap, confidence: 'low', support: c.assessment.support,
        },
      });
  }
}
