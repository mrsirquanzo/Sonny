import { z } from 'zod';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';
import { REGION_LABELS, boundForClaims } from './patentData.js';
import type { RegionAssociation, ExtractedPatent } from './patentData.js';
import type { RegionLabel, PatentRecord } from '@sonny/mcp-gateway';
import type { BlastHit, VerifiedSequence, PatentReconciliation } from './patentReconcile.js';

export interface ConstructMember { regionLabel: RegionLabel; seqId: number }
export interface AntibodyConstruct { name: string; members: ConstructMember[] }

export type CdrConfirmation = 'confirmed' | 'mismatch' | 'no_anchor';
export interface WorkedRegion {
  regionLabel: RegionLabel;
  seqId: number;
  residues: string;
  cdrConfirmation?: CdrConfirmation;
  blast?: BlastHit;
}

export type SpeciesClass = 'human-like' | 'chimeric' | 'murine' | 'unknown';
export interface SpeciesCall {
  classification: SpeciesClass;
  variableSpecies?: string;
  constantSpecies?: string;
  evidence: string;
}

export interface WorkedConstruct { name: string; regions: WorkedRegion[]; species: SpeciesCall }

export interface IpPoint { point: string; citations: string[] }
export interface CompetitiveIP { summary: string; points: IpPoint[] }

export type EdgePredicate = 'OWNED_BY' | 'DISCLOSES' | 'HAS_REGION' | 'MATCHES';
export interface Relationship {
  subject: string;
  predicate: EdgePredicate;
  object: string;
  provenance: string;
  confidence: 'verified' | 'claimed' | 'inferred';
}

export interface PatentWorkup {
  patentNumber: string | null;
  patent: PatentRecord;
  constructs: WorkedConstruct[];
  ungrouped: VerifiedSequence[];
  narrative: CompetitiveIP;
  graph: Relationship[];
}

const ConstructsSchema = z.object({
  constructs: z.array(z.object({
    name: z.string(),
    members: z.array(z.object({ regionLabel: z.enum(REGION_LABELS), seqId: z.number().int().positive() })),
  })),
});

const GROUP_SYSTEM =
  'You group a patent\'s disclosed antibody regions into distinct antibody constructs. Read the claims and the region-to-SEQ-ID associations. For each antibody the patent defines, output its name (or a label like "Antibody 1") and the members (regionLabel + seqId) that belong to it. Only use SEQ-IDs present in the associations. Never invent sequences or SEQ-IDs.';

export async function groupConstructs(
  markdown: string,
  associations: RegionAssociation[],
  model: StructuredModel,
): Promise<AntibodyConstruct[]> {
  const knownIds = new Set(associations.map((a) => a.seqId));
  try {
    const out = await model.generateStructured({
      system: GROUP_SYSTEM,
      prompt: `ASSOCIATIONS:\n${associations.map((a) => `${a.regionLabel} = SEQ ID NO: ${a.seqId}`).join('\n')}\n\nCLAIMS:\n${boundForClaims(markdown)}`,
      schema: ConstructsSchema,
      model: MODEL_ROUTER.specialist,
    });
    return out.constructs
      .map((c) => ({ name: c.name, members: c.members.filter((m) => knownIds.has(m.seqId)) }))
      .filter((c) => c.members.length > 0);
  } catch {
    return [];
  }
}
