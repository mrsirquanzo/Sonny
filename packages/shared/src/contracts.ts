import { z } from 'zod';

export const EvidenceKindSchema = z.enum(['target', 'publication', 'trial', 'patent', 'dataset', 'disease', 'drug']);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

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
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ClaimSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  citations: z.array(z.string()),
  confidence: z.number().min(0).max(1),
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
  | { type: 'research_reflect'; specialist: string; note: string; followups: string[] }
  | { type: 'lead_decompose'; specialists: string[] }
  | { type: 'completeness_verdict'; complete: boolean; gaps: string[] }
  | { type: 'gap_filler'; specialist: string; question: string }
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
});
export type Section = z.infer<typeof SectionSchema>;

export const VerdictLabelSchema = z.enum(['go', 'watch', 'no-go']);
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
}
