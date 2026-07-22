import { z } from 'zod';
import {
  AnalysisResultsSchema, JsonValueSchema, resolveResultBinding,
} from './results.js';
import {
  CanonicalDatasetInputSchema, ImageDigestSchema, Sha256Schema, computationId,
  sha256CanonicalJson, sha256Text,
} from './computationManifest.js';

export const EvidenceKindSchema = z.enum(['target', 'publication', 'trial', 'patent', 'dataset', 'disease', 'drug', 'figure', 'computation']);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const AuthorSchema = z.object({
  name: z.string().min(1),
  affiliation: z.string().optional(),
  orcid: z.string().optional(),
});
export type Author = z.infer<typeof AuthorSchema>;

export const EvidenceMetadataSchema = z.object({
  authors: z.array(AuthorSchema).optional(),
  institutions: z.array(z.string()).optional(),
  figureType: z.string().optional(),
  imageRef: z.string().optional(),
  doi: z.string().optional(),
  journal: z.string().optional(),
  year: z.string().optional(),
  crossrefVerified: z.boolean().optional(),
});
export type EvidenceMetadata = z.infer<typeof EvidenceMetadataSchema>;

const EvidenceCommonSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  title: z.string(),
  snippet: z.string(),
  passage: z.string().optional(),
  locator: z.string().optional(),
  url: z.string(),
  raw: z.unknown(),
  retrievedAt: z.string(),
  metadata: EvidenceMetadataSchema.optional(),
});

export const LiteratureEvidenceSchema = EvidenceCommonSchema.extend({
  kind: z.enum(['target', 'publication', 'trial', 'patent', 'dataset', 'disease', 'drug', 'figure']),
});

export const ComputationDatasetInputSchema = CanonicalDatasetInputSchema.extend({
  lineageManifest: z.record(JsonValueSchema),
}).strict();

export const ComputationExitStatusSchema = z.object({
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  signal: z.string().min(1).nullable(),
}).strict();

export const ComputationEvidenceObjectSchema = EvidenceCommonSchema.extend({
  kind: z.literal('computation'),
  computationId: Sha256Schema,
  templateId: z.string().min(1),
  templateVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  datasetInputs: z.array(ComputationDatasetInputSchema).min(1),
  imageDigest: ImageDigestSchema,
  codeBytes: z.string().min(1),
  codeHash: Sha256Schema,
  params: z.record(JsonValueSchema),
  seed: z.number().int().nonnegative(),
  exitStatus: ComputationExitStatusSchema,
  resultKeys: z.array(z.string().min(1)).min(1),
  resultsJsonHash: Sha256Schema,
  raw: AnalysisResultsSchema,
});

function validateComputationEvidence(value: z.infer<typeof ComputationEvidenceObjectSchema>, ctx: z.RefinementCtx): void {
  const manifest = {
    manifestVersion: '1.0.0' as const,
    templateId: value.templateId,
    templateVersion: value.templateVersion,
    datasets: value.datasetInputs.map(({ lineageManifest: _lineageManifest, ...dataset }) => dataset),
    imageDigest: value.imageDigest,
    codeHash: value.codeHash,
    params: value.params,
    seed: value.seed,
  };
  if (computationId(manifest) !== value.computationId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['computationId'], message: 'does not match the canonical computation manifest' });
  }
  if (sha256Text(value.codeBytes) !== value.codeHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['codeHash'], message: 'does not match codeBytes' });
  }
  if (sha256CanonicalJson(value.raw) !== value.resultsJsonHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['resultsJsonHash'], message: 'does not match canonical results.json' });
  }
  for (const dataset of value.datasetInputs) {
    if (sha256CanonicalJson(dataset.lineageManifest) !== dataset.lineageManifestHash) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['datasetInputs'], message: `lineage manifest hash mismatch for ${dataset.datasetId}` });
    }
  }
  for (const resultKey of value.resultKeys) {
    if (!resolveResultBinding(value.raw, resultKey)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['resultKeys'], message: `unknown scalar result binding: ${resultKey}` });
    }
  }
}

export const ComputationEvidenceSchema = ComputationEvidenceObjectSchema.superRefine(validateComputationEvidence);
export const EvidenceSchema = z.discriminatedUnion('kind', [
  LiteratureEvidenceSchema,
  ComputationEvidenceObjectSchema,
]).superRefine((value, ctx) => {
  if (value.kind === 'computation') validateComputationEvidence(value, ctx);
});
export type Evidence = z.infer<typeof EvidenceSchema>;
export type ComputationEvidence = z.infer<typeof ComputationEvidenceSchema>;

export const BiasRiskSchema = z.enum(['low', 'moderate', 'high']);
export type BiasRisk = z.infer<typeof BiasRiskSchema>;

export const RedFlagCategorySchema = z.enum([
  'surrogate_endpoint', 'high_dropout', 'p_hacking', 'active_control_mismatch', 'unblinded',
]);
export type RedFlagCategory = z.infer<typeof RedFlagCategorySchema>;

export const RedFlagSchema = z.object({
  category: RedFlagCategorySchema,
  biasRisk: BiasRiskSchema,
  explanation: z.string().min(1),
});
export type RedFlag = z.infer<typeof RedFlagSchema>;

export const StudyDesignSchema = z.enum([
  'randomized_controlled', 'single_arm', 'post_hoc', 'observational', 'preclinical_nhp', 'in_vitro',
]);
export type StudyDesign = z.infer<typeof StudyDesignSchema>;

export const EvidenceLevelSchema = z.enum(['high', 'moderate', 'low', 'very_low']);
export type EvidenceLevel = z.infer<typeof EvidenceLevelSchema>;

export const MethodologicalCritiqueSchema = z.object({
  evidenceId: z.string().min(1),
  studyDesign: StudyDesignSchema,
  sampleSize: z.number().int().positive().nullable().optional(),
  redFlags: z.array(RedFlagSchema),
  evidenceLevel: EvidenceLevelSchema.optional(),
});
export type MethodologicalCritique = z.infer<typeof MethodologicalCritiqueSchema>;

export const ContradictionFlagSchema = z.object({
  evidenceIdA: z.string().min(1),
  evidenceIdB: z.string().min(1),
  endpoint: z.string().min(1),
  explanation: z.string().min(1),
});
export type ContradictionFlag = z.infer<typeof ContradictionFlagSchema>;

export const DevelopabilitySeveritySchema = z.enum(['manageable', 'significant', 'severe']);
export type DevelopabilitySeverity = z.infer<typeof DevelopabilitySeveritySchema>;

export const DevelopabilityCategorySchema = z.enum([
  'immunogenicity', 'half_life', 'dosing', 'off_target_toxicity', 'fc_engineering', 'manufacturability',
]);
export type DevelopabilityCategory = z.infer<typeof DevelopabilityCategorySchema>;

export const DevelopabilityRiskSchema = z.object({
  evidenceId: z.string().min(1),
  category: DevelopabilityCategorySchema,
  severity: DevelopabilitySeveritySchema,
  explanation: z.string().min(1),
});
export type DevelopabilityRisk = z.infer<typeof DevelopabilityRiskSchema>;

export const ExecutionModeSchema = z.enum(['live', 'cached']);
export const ReplayVerificationSchema = z.enum(['verified', 'not_run']);
export const OriginVerificationSchema = z.enum(['verified', 'none']);
export const VerdictStatusSchema = z.enum(['supported', 'unsupported', 'overreach']);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;
export type ReplayVerification = z.infer<typeof ReplayVerificationSchema>;
export type OriginVerification = z.infer<typeof OriginVerificationSchema>;

export const ComputedBindingSchema = z.object({
  computationId: Sha256Schema,
  resultKey: z.string().min(1),
  assertedValue: z.number().finite(),
  assertedUnit: z.string().min(1),
}).strict();
export type ComputedBinding = z.infer<typeof ComputedBindingSchema>;

export const ClaimSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  citations: z.array(z.string()),
  confidence: z.number().transform((n) => Math.max(0, Math.min(1, n))),
  redFlags: z.array(RedFlagSchema).optional(),
  computedBinding: ComputedBindingSchema.optional(),
  executionMode: ExecutionModeSchema.optional(),
  replayVerification: ReplayVerificationSchema.optional(),
  originVerification: OriginVerificationSchema.optional(),
  llmVerdict: VerdictStatusSchema.optional(),
  verifierDecorrelated: z.boolean().optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const ClaimsSchema = z.object({ claims: z.array(ClaimSchema) });

export type VerdictStatus = z.infer<typeof VerdictStatusSchema>;

export const VerdictSchema = z.object({
  claimId: z.string().min(1),
  status: VerdictStatusSchema,
  rationale: z.string(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const SpecialtyLabSchema = z.object({
  investigator: z.string().min(1),
  institution: z.string().optional(),
  paperCount: z.number().int().nonnegative(),
  weight: z.number(),
  evidenceIds: z.array(z.string()),
});
export type SpecialtyLab = z.infer<typeof SpecialtyLabSchema>;

export const KOLClusterSchema = z.object({
  target: z.string(),
  labs: z.array(SpecialtyLabSchema),
});
export type KOLCluster = z.infer<typeof KOLClusterSchema>;

// --- Figure evidence (Slice 4) ---

// The sidecar WIRE response. Carries NO inCaption and NO readRisk; those are
// derived in TypeScript by readFigures (see mcp-gateway/figureRead.ts).
export const ExtractedValueWireSchema = z.object({
  label: z.string(),
  value: z.string(),
  unit: z.string().optional(),
});
export const FigureReadingWireSchema = z.object({
  figureId: z.string().min(1),
  relevanceScore: z.number(),
  figureType: z.string().optional(),
  reading: z.string(),
  extractedValues: z.array(ExtractedValueWireSchema),
  confidence: z.number().min(0).max(1),
});
export const FiguresAnalyzeResponseSchema = z.object({
  readings: z.array(FigureReadingWireSchema),
});
export type FiguresAnalyzeResponse = z.infer<typeof FiguresAnalyzeResponseSchema>;

export const FigureTypeSchema = z.enum([
  'forest_plot', 'kaplan_meier', 'dose_response', 'bar', 'flow', 'other',
]);
export type FigureType = z.infer<typeof FigureTypeSchema>;

// The Tool's OUTPUT. inCaption is a deterministic TS fact; readRisk is binary.
export const ExtractedValueSchema = z.object({
  label: z.string(),
  value: z.string(),
  unit: z.string().optional(),
  inCaption: z.boolean(),
  readRisk: z.enum(['low', 'high']),
});
export type ExtractedValue = z.infer<typeof ExtractedValueSchema>;

export const FigureReadingSchema = z.object({
  evidenceId: z.string().min(1),
  figureType: FigureTypeSchema.optional(),
  reading: z.string(),
  extractedValues: z.array(ExtractedValueSchema),
  confidence: z.number().min(0).max(1),
});
export type FigureReading = z.infer<typeof FigureReadingSchema>;

export interface ExtractionCompletenessLike {
  foundCount: number;
  referencedMax: number;
  missingSeqIds: number[];
  alphabetWarnings: Array<{ seqId: number; invalidChars: string }>;
  associationCount: number;
}

export type TraceEvent =
  | { type: 'plan'; specialists: string[]; tools: string[] }
  | { type: 'tool_call'; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; count: number }
  | { type: 'evidence_registered'; id: string; title: string }
  | { type: 'claim_drafted'; claim: Claim }
  | { type: 'verdict'; verdict: Verdict }
  | { type: 'synthesis'; section: string }
  | { type: 'error'; message: string }
  | { type: 'specialist_start'; specialist: string }
  | { type: 'specialist_skipped'; specialist: string; reason: string }
  | { type: 'section_complete'; section: Section }
  | { type: 'research_plan'; specialist: string; questions: string[] }
  | { type: 'query_rewrite'; specialist: string; question: string; variants: string[] }
  | { type: 'dense_score'; specialist: string; model: string; candidates: number }
  | { type: 'fusion'; specialist: string; before: string[]; after: string[] }
  | { type: 'research_read'; specialist: string; sourceId: string; locator: string }
  | { type: 'rerank'; specialist: string; before: string[]; after: string[] }
  | { type: 'research_reflect'; specialist: string; note: string; followups: string[] }
  | { type: 'query_parsed'; target: string; indication?: string; modality?: string }
  | { type: 'modality_inferred'; target: string; modality: string; rationale?: string }
  | { type: 'plan_composed'; modality: string; specialists: Array<{ id: string; title: string; weight?: number }>; rationale?: string }
  | { type: 'lead_decompose'; specialists: string[] }
  | { type: 'completeness_verdict'; complete: boolean; gaps: string[] }
  | { type: 'gap_filler'; specialist: string; question: string }
  | { type: 'methodological_critique'; specialist: string; critique: MethodologicalCritique }
  | { type: 'contradiction'; flag: ContradictionFlag }
  | { type: 'figure_read'; specialist: string; readings: FigureReading[] }
  | { type: 'developability_assessment'; risks: DevelopabilityRisk[] }
  | { type: 'kol_cluster'; cluster: KOLCluster }
  | { type: 'recommendation'; verdict: string }
  | { type: 'patent_ingest'; status: 'ok' | 'failed'; format?: string }  // format reserved for a future ingest that reports source format
  | { type: 'patent_extracted'; patentNumber: string | null; sequenceCount: number }
  | { type: 'patent_associations'; associationCount: number; source: 'st26' | 'llm' }
  | { type: 'patent_complete'; completeness: ExtractionCompletenessLike }
  | { type: 'reference_check'; id: string; doi?: string; verified: boolean; note?: string };

export const RagRatingSchema = z.enum(['green', 'amber', 'red']);
export type RagRating = z.infer<typeof RagRatingSchema>;

const SectionBaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  takeaway: z.string(),
  claims: z.array(ClaimSchema),
  sources: z.array(z.string()),
  rag: RagRatingSchema,
  critiques: z.array(MethodologicalCritiqueSchema).optional(),
  developabilityRisks: z.array(DevelopabilityRiskSchema).optional(),
});

export const ResearchSectionSchema = SectionBaseSchema.extend({ kind: z.literal('research') });
export const AnalysisSectionSchema = SectionBaseSchema.extend({
  kind: z.literal('analysis'),
  computationIds: z.array(Sha256Schema).min(1),
  figurePaths: z.array(z.string().min(1)),
});
export const SectionSchema = z.discriminatedUnion('kind', [ResearchSectionSchema, AnalysisSectionSchema]);
export type Section = z.infer<typeof SectionSchema>;

/** One-way migration for pre-Slice-2 serialized sections. */
export function migrateSectionsToV1(sections: readonly unknown[]): Section[] {
  return sections.map((section) => {
    if (typeof section !== 'object' || section === null || Array.isArray(section)) {
      return SectionSchema.parse(section);
    }
    const record = section as Record<string, unknown>;
    return SectionSchema.parse(record.kind === undefined ? { ...record, kind: 'research' } : record);
  });
}

export const VerdictLabelSchema = z.enum(['go', 'watch', 'no-go', 'insufficient-evidence']);
export type VerdictLabel = z.infer<typeof VerdictLabelSchema>;

export const CasePointSchema = z.object({
  point: z.string().min(1),
  citations: z.array(z.string()),
});
export type CasePoint = z.infer<typeof CasePointSchema>;

export const RecommendationSchema = z.object({
  // `verdict` is retained as an INTERNAL evidence-posture signal (for the eval
  // harness and abstention), not a directive shown to the user. The user-facing
  // memo models a balanced scientist's assessment: a framing that holds the
  // tension, the case for and against, and a bottom-line positioning - the
  // decision stays with the team.
  verdict: VerdictLabelSchema,
  thesis: z.string().min(1),
  /** Balanced 2-3 sentence read: what the target is and the central tension. */
  framing: z.string().optional(),
  bull: z.array(CasePointSchema),
  bear: z.array(CasePointSchema),
  /** Where the target is most compelling, the biggest risks, and what would change the read. Not a recommendation. */
  bottomLine: z.string().optional(),
  conditions: z.array(z.string()),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const LiteratureReferenceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['target', 'publication', 'trial', 'patent', 'dataset', 'disease', 'drug', 'figure']),
  source: z.string(),
  title: z.string(),
  url: z.string(),
  snippet: z.string().optional(),
  raw: z.unknown().optional(),
});

export const ComputationReferenceSchema = ComputationEvidenceObjectSchema.omit({
  snippet: true,
  passage: true,
  locator: true,
  raw: true,
  metadata: true,
});
export const ReferenceSchema = z.discriminatedUnion('kind', [LiteratureReferenceSchema, ComputationReferenceSchema]);
export type Reference = z.infer<typeof ReferenceSchema>;

// Per-run accounting: wall-clock duration plus token/cost usage per model.
// `pricingKnown` is false when any model that logged calls has no price entry,
// so a partial cost is never presented as a complete one.
export const RunMetaSchema = z.object({
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number(),
  backend: z.string(),
  calls: z.number(),
  models: z.array(z.object({
    model: z.string(),
    calls: z.number(),
    tokensIn: z.number(),
    tokensOut: z.number(),
    costUsd: z.number().optional(),
  })),
  totals: z.object({
    tokensIn: z.number(),
    tokensOut: z.number(),
    costUsd: z.number().optional(),
  }),
  pricingKnown: z.boolean(),
});
export type RunMeta = z.infer<typeof RunMetaSchema>;

export interface Briefing {
  target: string;
  recommendation: Recommendation;
  executiveRead: string;
  sections: Section[];
  weighing: { takeaway: string; claims: Claim[] };
  references: Reference[];
  kolCluster?: KOLCluster;
  /** Optional so run JSON written before metering existed stays valid. */
  runMeta?: RunMeta;
}
