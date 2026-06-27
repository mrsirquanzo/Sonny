import { z } from 'zod';

export const EvidenceKindSchema = z.enum(['target', 'publication', 'trial', 'patent', 'dataset']);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const EvidenceSchema = z.object({
  id: z.string().min(1),
  kind: EvidenceKindSchema,
  source: z.string().min(1),
  title: z.string(),
  snippet: z.string(),
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
  | { type: 'error'; message: string };
