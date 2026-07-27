import { z } from 'zod';
import { SpecialistAxisIdSchema, type SpecialistAxisId } from './specialistAxes.js';
import { SectionScopeSchema, REQUIRED_SCOPE_KINDS, type SectionScope } from './scope.js';
import { SpecialistConclusionSchema } from './conclusions.js';
import {
  ClaimSchema, MethodologicalCritiqueSchema, RagRatingSchema,
  LegacyDevelopabilityRiskSchema,
} from './contracts.js';
import { Sha256Schema } from './computationManifest.js';

const SectionBaseSchema = z.object({
  title: z.string().min(1),
  takeaway: z.string(),
  claims: z.array(ClaimSchema),
  sources: z.array(z.string()),
  rag: RagRatingSchema,
  // No Zod default: a default is materialized at parse time, so a stored
  // section would silently acquire a property it was never written with.
  visibility: z.enum(['dossier', 'audit']).optional(),
  critiques: z.array(MethodologicalCritiqueSchema).optional(),
});

/**
 * Runs predating the conclusion contract. Read-only.
 *
 * `schemaVersion: z.never().optional()` is load-bearing. Verified against zod:
 * without it, `z.union([V2, Legacy]).parse({kind:'research', schemaVersion:2,
 * id:'target_biology'})` (conclusion missing) SUCCEEDS through the legacy
 * branch and returns the object with `schemaVersion` STRIPPED, destroying the
 * evidence it was ever V2. Branch order does not protect a union.
 *
 * `developabilityRisks` is declared under its stored name; omit it and zod
 * strips stored dossier risks on read.
 */
export const LegacyResearchSectionSchema = SectionBaseSchema.extend({
  kind: z.literal('research'),
  schemaVersion: z.never().optional(),
  id: SpecialistAxisIdSchema,
  conclusion: SpecialistConclusionSchema.optional(),
  scope: SectionScopeSchema.optional(),
  developabilityRisks: z.array(LegacyDevelopabilityRiskSchema).optional(),
});
export type LegacyResearchSection = z.infer<typeof LegacyResearchSectionSchema>;

/** The contract every new research section MUST satisfy. */
export const ResearchSectionV2Schema = SectionBaseSchema.extend({
  kind: z.literal('research'),
  schemaVersion: z.literal(2),
  id: SpecialistAxisIdSchema,
  scope: SectionScopeSchema,
  conclusion: SpecialistConclusionSchema,
  strategyFingerprintRef: z.string().optional(),
}).superRefine((s, ctx) => {
  if (s.conclusion.axis !== s.id) {
    ctx.addIssue({ code: 'custom', message: `conclusion.axis ${s.conclusion.axis} does not match section id ${s.id}` });
  }
  if (!REQUIRED_SCOPE_KINDS[s.id].includes(s.scope.kind)) {
    ctx.addIssue({ code: 'custom', message: `axis ${s.id} may not use scope ${s.scope.kind}` });
  }
  // Q3 mode is constrained by scope: overlays are per strategy, the comparative
  // ranking is the single shared output.
  if (s.id === 'disease_indications' && s.conclusion.axis === 'disease_indications') {
    const mode = s.conclusion.conclusion.mode;
    if (s.scope.kind === 'strategy' && mode !== 'strategy_overlay') {
      ctx.addIssue({ code: 'custom', message: 'strategy-scoped disease_indications requires mode strategy_overlay' });
    }
    if (s.scope.kind === 'shared' && mode !== 'comparative') {
      ctx.addIssue({ code: 'custom', message: 'shared disease_indications requires mode comparative' });
    }
  }
});
export type ResearchSectionV2 = z.infer<typeof ResearchSectionV2Schema>;

export const AnalysisSectionV2Schema = SectionBaseSchema.extend({
  kind: z.literal('analysis'),
  id: z.string().min(1),
  computationIds: z.array(Sha256Schema).min(1),
  figurePaths: z.array(z.string().min(1)),
});
export type AnalysisSectionV2 = z.infer<typeof AnalysisSectionV2Schema>;

/** Writers MUST use this. */
export const CurrentSectionSchema = z.union([ResearchSectionV2Schema, AnalysisSectionV2Schema]);
export type CurrentSection = z.infer<typeof CurrentSectionSchema>;

export type StoredSection = ResearchSectionV2 | LegacyResearchSection | AnalysisSectionV2;

/**
 * Runtime reads go through here, never through a bare union over the two
 * research schemas. Dispatching on `schemaVersion` gives a versioned input
 * exactly one chance to parse, so a malformed V2 section fails loudly instead
 * of being laundered into a legacy section.
 */
export function parseStoredSection(input: unknown): StoredSection {
  if (typeof input === 'object' && input !== null && 'schemaVersion' in input) {
    return ResearchSectionV2Schema.parse(input);
  }
  return z.union([LegacyResearchSectionSchema, AnalysisSectionV2Schema]).parse(input);
}

export function migrateStoredSections(sections: readonly unknown[]): StoredSection[] {
  return sections.map((section) => {
    if (typeof section !== 'object' || section === null || Array.isArray(section)) {
      return parseStoredSection(section);
    }
    const record = section as Record<string, unknown>;
    return parseStoredSection(record.kind === undefined ? { ...record, kind: 'research' } : record);
  });
}

export function sectionKeyOf(id: SpecialistAxisId, scope: SectionScope | undefined): string {
  if (!scope) return `${id}::shared`;
  switch (scope.kind) {
    case 'shared':        return `${id}::shared`;
    case 'strategy':      return `${id}::strategy::${scope.strategyFingerprint}`;
    case 'q1_hypothesis': return `${id}::q1::${scope.q1HypothesisKey}`;
  }
}
