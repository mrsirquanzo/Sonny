import { z } from 'zod';
import { SpecialistAxisIdSchema, type SpecialistAxisId } from './specialistAxes.js';

export const RetrievalSourceIdSchema = z.enum([
  'europepmc', 'pubmed', 'clinicaltrials', 'opentargets',
  'espacenet', 'crossref', 'hpa', 'gtex', 'uniprot',
]);
export type RetrievalSourceId = z.infer<typeof RetrievalSourceIdSchema>;

export const RetrievalQueryClassSchema = z.enum([
  'target', 'target_indication', 'target_modality', 'target_class_precedent',
  'mechanism', 'competitor_landscape', 'patent_landscape', 'safety_class',
]);
export type RetrievalQueryClass = z.infer<typeof RetrievalQueryClassSchema>;

/**
 * ONE audit records ONE (source, queryClass) execution. Adequacy is judged over
 * a SET of audits by `evaluateRetrievalCoverage`, never by the presence of a
 * single record: one zero-result query is evidence of one query, not of coverage.
 *
 * `queryFingerprint` and `normalizedQueryTerms` exist so two audits with the
 * same (source, queryClass) are distinguishable. Without them a malformed query
 * and a correct one look identical in the record.
 */
export const RetrievalAuditSchema = z.object({
  id: z.string().min(1),
  axis: SpecialistAxisIdSchema,
  sectionKey: z.string().min(1),
  sourceId: RetrievalSourceIdSchema,
  queryClass: RetrievalQueryClassSchema,
  queryFingerprint: z.string().min(1),
  normalizedQueryTerms: z.array(z.string().min(1)).min(1),
  renderedQuery: z.string().optional(),
  status: z.enum(['completed', 'partial', 'failed']),
  executedAt: z.string().datetime(),
  rawResultCount: z.number().int().nonnegative(),
  relevantResultCount: z.number().int().nonnegative(),
  timeWindowStart: z.string().datetime().optional(),
  timeWindowEnd: z.string().datetime().optional(),
});
export type RetrievalAudit = z.infer<typeof RetrievalAuditSchema>;

/**
 * A required source GROUP expresses OR: one source from each inner array.
 * A flat list could not express "Europe PMC or PubMed".
 */
export type RetrievalCoverageRequirement = {
  sourceGroups: RetrievalSourceId[][];
  requiredQueryClasses: RetrievalQueryClass[];
};

/** Coverage required before an absence conclusion may stand. */
export const ABSENCE_COVERAGE_REQUIREMENTS = {
  q4_precedent_absent: {
    sourceGroups: [['clinicaltrials'], ['europepmc', 'pubmed'], ['opentargets']],
    requiredQueryClasses: ['target_modality', 'target_class_precedent'],
  },
  q5_landscape_open: {
    sourceGroups: [['clinicaltrials'], ['opentargets'], ['espacenet']],
    requiredQueryClasses: ['competitor_landscape', 'patent_landscape'],
  },
  q6_risk_low: {
    sourceGroups: [['europepmc', 'pubmed'], ['opentargets']],
    requiredQueryClasses: ['safety_class', 'target_modality'],
  },
} as const satisfies Record<string, RetrievalCoverageRequirement>;

export type RetrievalCoverageResult = {
  adequate: boolean;
  missingSourceGroups: RetrievalSourceId[][];
  missingQueryClasses: RetrievalQueryClass[];
  failedAuditIds: string[];
  partialAuditIds: string[];
};

/**
 * Deterministic. A model never asserts its own coverage.
 *
 * `failed` never counts. `partial` is reported but does NOT satisfy a required
 * source group: "counts if the set is otherwise complete" was ambiguous, and a
 * partial search is exactly the case where an absence claim is least safe.
 */
export function evaluateRetrievalCoverage(opts: {
  requirement: RetrievalCoverageRequirement;
  audits: readonly RetrievalAudit[];
  /** Only audits for THIS section count. Absence is a claim about this
   *  question, not about whatever else the run happened to search. */
  sectionKey: string;
  axis: SpecialistAxisId;
}): RetrievalCoverageResult {
  const { requirement, audits, sectionKey, axis } = opts;
  const mine = audits.filter((a) => a.sectionKey === sectionKey && a.axis === axis);

  const failedAuditIds = mine.filter((a) => a.status === 'failed').map((a) => a.id);
  const partialAuditIds = mine.filter((a) => a.status === 'partial').map((a) => a.id);
  const usable = mine.filter((a) => a.status === 'completed');

  // A required source is satisfied only by an audit that ran a REQUIRED query
  // class against it. Checking the source set and class set independently lets
  // an unrelated query on the right source satisfy the requirement: searching
  // ClinicalTrials for `mechanism` is not evidence about `target_modality`.
  const missingSourceGroups = requirement.sourceGroups.filter(
    (group) => !usable.some(
      (a) => group.includes(a.sourceId) && requirement.requiredQueryClasses.includes(a.queryClass),
    ),
  );
  const missingQueryClasses = requirement.requiredQueryClasses.filter(
    (c) => !usable.some((a) => a.queryClass === c),
  );

  return {
    adequate: missingSourceGroups.length === 0 && missingQueryClasses.length === 0,
    missingSourceGroups,
    missingQueryClasses,
    failedAuditIds,
    partialAuditIds,
  };
}

/** Run-local store, sibling to the EvidenceStore. */
export class RetrievalAuditStore {
  private readonly byId = new Map<string, RetrievalAudit>();
  register(a: RetrievalAudit): void { if (!this.byId.has(a.id)) this.byId.set(a.id, a); }
  get(id: string): RetrievalAudit | undefined { return this.byId.get(id); }
  has(id: string): boolean { return this.byId.has(id); }
  all(): RetrievalAudit[] { return [...this.byId.values()]; }
}
