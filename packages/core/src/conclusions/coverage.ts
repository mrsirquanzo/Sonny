import {
  ABSENCE_COVERAGE_REQUIREMENTS,
  evaluateRetrievalCoverage,
  type SpecialistConclusion,
  type Claim,
} from '@mrsirquanzo/sonny-shared';
import type { RetrievalAuditStore } from '@mrsirquanzo/sonny-shared';

/** Axes whose absence-shaped answers require demonstrated retrieval coverage. */
type AbsenceKind = keyof typeof ABSENCE_COVERAGE_REQUIREMENTS;

/**
 * Is this conclusion asserting an ABSENCE?
 *
 * An absence is the one conclusion no citation can ground: "no precedent
 * exists" is supported by searches that ran and found nothing, not by a paper
 * saying so. These three are the spec's absence shapes.
 */
export function absenceKindOf(c: SpecialistConclusion): AbsenceKind | undefined {
  if (c.axis === 'clinical_landscape' && c.assessment.precedent === 'absent') return 'q4_precedent_absent';
  if (c.axis === 'competitive_ip' && c.assessment.landscapeDensity === 'open') return 'q5_landscape_open';
  if (c.axis === 'modality_developability' && c.assessment.overallDevelopmentRisk === 'low') return 'q6_risk_low';
  return undefined;
}

/**
 * Does an absence conclusion have the coverage to stand?
 *
 * Two independent gates, and both matter. Every cited audit id must RESOLVE in
 * the store - an id that names nothing is a phantom citation wearing a
 * different hat. And the resolved audits must actually SATISFY the requirement
 * for this axis and section: citing three audits that all searched the wrong
 * source is coverage on paper only.
 */
export function absenceCoverageHolds(opts: {
  conclusion: SpecialistConclusion;
  sectionKey: string;
  auditStore: RetrievalAuditStore;
}): { adequate: boolean; reason?: string; resolvedAuditIds: string[]; droppedAuditIds: string[] } {
  const { conclusion, sectionKey, auditStore } = opts;
  const kind = absenceKindOf(conclusion);
  const support = 'assessment' in conclusion ? conclusion.assessment.support : undefined;
  const auditIds = support?.retrievalAuditIds ?? [];

  // An unresolvable audit id is pruned and traced, exactly as an unresolvable
  // evidence id is. It is not on its own fatal: a phantom id alongside three
  // real, adequate audits should lose the phantom, not the conclusion. What
  // decides the conclusion is whether the SURVIVING audits cover the
  // requirement.
  const resolvedAuditIds = auditIds.filter((id) => auditStore.has(id));
  const droppedAuditIds = auditIds.filter((id) => !auditStore.has(id));

  if (!kind) return { adequate: true, resolvedAuditIds, droppedAuditIds };

  if (resolvedAuditIds.length === 0) {
    return {
      adequate: false,
      reason: `${kind}: absence conclusion carries no resolvable retrievalAuditIds`,
      resolvedAuditIds, droppedAuditIds,
    };
  }

  const audits = resolvedAuditIds.map((id) => auditStore.get(id)!);
  const result = evaluateRetrievalCoverage({
    requirement: ABSENCE_COVERAGE_REQUIREMENTS[kind],
    audits,
    sectionKey,
    axis: conclusion.axis,
  });
  if (!result.adequate) {
    const missing = [
      result.missingSourceGroups.length ? `sources ${result.missingSourceGroups.map((g) => g.join('|')).join(', ')}` : '',
      result.missingQueryClasses.length ? `query classes ${result.missingQueryClasses.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    return { adequate: false, reason: `${kind}: retrieval coverage inadequate (${missing})`, resolvedAuditIds, droppedAuditIds };
  }
  return { adequate: true, resolvedAuditIds, droppedAuditIds };
}

/** Top-level status of a conclusion, for the coverage gate. */
export function conclusionStatus(c: SpecialistConclusion): string {
  switch (c.axis) {
    case 'target_biology':
      // Q1 carries per-context assessments rather than one status. It is
      // materially covered when any context reached a real validity judgment.
      return c.assessments.some((a) => a.validity !== 'insufficient_evidence')
        ? 'assessed' : 'insufficient_evidence';
    case 'moa_pathway': return c.assessment.modalityFit;
    case 'disease_indications':
      return c.conclusion.mode === 'comparative'
        ? (c.conclusion.assessments.length ? 'assessed' : 'insufficient_evidence')
        : (c.conclusion.assessments.length ? 'assessed' : 'insufficient_evidence');
    case 'clinical_landscape': return c.assessment.precedent;
    case 'competitive_ip': return c.assessment.landscapeDensity;
    case 'modality_developability': return c.assessment.overallDevelopmentRisk;
  }
}

/** An axis is materially covered when its top-level status is not `insufficient_evidence`. */
export function isMateriallyCovered(c: SpecialistConclusion): boolean {
  return conclusionStatus(c) !== 'insufficient_evidence';
}

/** Q1 and Q2: without target validity or modality feasibility there is no thesis to argue. */
const CRITICAL_AXES = ['target_biology', 'moa_pathway'] as const;

/**
 * Coverage-based abstention (spec 12.4, normative).
 *
 * Replaces slice 0's raw count. Two verified claims on a single axis is not a
 * dossier, and the count could not tell the difference.
 */
export function evaluateAbstention(opts: {
  conclusions: readonly SpecialistConclusion[];
  verifiedClaims: readonly Claim[];
}): { proceed: boolean; reasons: string[] } {
  const { conclusions, verifiedClaims } = opts;
  const reasons: string[] = [];

  // Deterministic claims are curated cards, present for every target with an
  // Open Targets entry. Counting them would let a dossier with no model
  // findings at all clear the gate.
  const nonDeterministic = verifiedClaims.filter((c) => c.provenance !== 'deterministic');
  if (nonDeterministic.length < 2) {
    reasons.push(`only ${nonDeterministic.length} verified non-deterministic claim(s), need 2`);
  }

  const covered = conclusions.filter(isMateriallyCovered);
  if (covered.length < 2) {
    reasons.push(`only ${covered.length} materially covered axis/axes, need 2`);
  }

  for (const axis of CRITICAL_AXES) {
    const c = conclusions.find((x) => x.axis === axis);
    if (!c) { reasons.push(`critical axis ${axis} has no conclusion`); continue; }
    if (!isMateriallyCovered(c)) reasons.push(`critical axis ${axis} is insufficient_evidence`);
  }

  return { proceed: reasons.length === 0, reasons };
}
