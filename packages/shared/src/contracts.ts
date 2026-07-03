import { z } from 'zod';

export const EvidenceKindSchema = z.enum(['target', 'publication', 'trial', 'patent', 'dataset', 'disease', 'drug', 'figure']);
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
});
export type EvidenceMetadata = z.infer<typeof EvidenceMetadataSchema>;

export const EvidenceSchema = z.object({
  id: z.string().min(1),
  kind: EvidenceKindSchema,
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
export type Evidence = z.infer<typeof EvidenceSchema>;

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

export const MethodologicalCritiqueSchema = z.object({
  evidenceId: z.string().min(1),
  studyDesign: StudyDesignSchema,
  sampleSize: z.number().int().positive().nullable().optional(),
  redFlags: z.array(RedFlagSchema),
});
export type MethodologicalCritique = z.infer<typeof MethodologicalCritiqueSchema>;

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

export const ClaimSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  citations: z.array(z.string()),
  confidence: z.number().transform((n) => Math.max(0, Math.min(1, n))),
  redFlags: z.array(RedFlagSchema).optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const ClaimsSchema = z.object({ claims: z.array(ClaimSchema) });

export const VerdictStatusSchema = z.enum(['supported', 'unsupported', 'overreach']);
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
  | { type: 'research_read'; specialist: string; sourceId: string; locator: string }
  | { type: 'rerank'; specialist: string; before: string[]; after: string[] }
  | { type: 'research_reflect'; specialist: string; note: string; followups: string[] }
  | { type: 'lead_decompose'; specialists: string[] }
  | { type: 'completeness_verdict'; complete: boolean; gaps: string[] }
  | { type: 'gap_filler'; specialist: string; question: string }
  | { type: 'methodological_critique'; specialist: string; critique: MethodologicalCritique }
  | { type: 'figure_read'; specialist: string; readings: FigureReading[] }
  | { type: 'developability_assessment'; risks: DevelopabilityRisk[] }
  | { type: 'kol_cluster'; cluster: KOLCluster }
  | { type: 'recommendation'; verdict: string };

export const RagRatingSchema = z.enum(['green', 'amber', 'red']);
export type RagRating = z.infer<typeof RagRatingSchema>;

export const SectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  takeaway: z.string(),
  claims: z.array(ClaimSchema),
  sources: z.array(z.string()),
  rag: RagRatingSchema,
  critiques: z.array(MethodologicalCritiqueSchema).optional(),
  developabilityRisks: z.array(DevelopabilityRiskSchema).optional(),
});
export type Section = z.infer<typeof SectionSchema>;

export const VerdictLabelSchema = z.enum(['go', 'watch', 'no-go', 'insufficient-evidence']);
export type VerdictLabel = z.infer<typeof VerdictLabelSchema>;

export const CasePointSchema = z.object({
  point: z.string().min(1),
  citations: z.array(z.string()),
});
export type CasePoint = z.infer<typeof CasePointSchema>;

export const RecommendationSchema = z.object({
  verdict: VerdictLabelSchema,
  thesis: z.string().min(1),
  bull: z.array(CasePointSchema),
  bear: z.array(CasePointSchema),
  conditions: z.array(z.string()),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const ReferenceSchema = z.object({
  id: z.string().min(1),
  kind: EvidenceKindSchema,
  source: z.string(),
  title: z.string(),
  url: z.string(),
});
export type Reference = z.infer<typeof ReferenceSchema>;

export interface Briefing {
  target: string;
  recommendation: Recommendation;
  executiveRead: string;
  sections: Section[];
  weighing: { takeaway: string; claims: Claim[] };
  references: Reference[];
  kolCluster?: KOLCluster;
}
