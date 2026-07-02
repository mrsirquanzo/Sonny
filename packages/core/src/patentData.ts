import { z } from 'zod';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';
import { extractPatentNumber, extractSequenceListing } from '@sonny/mcp-gateway';
import type { ExtractedSequence, RegionLabel } from '@sonny/mcp-gateway';

export interface RegionAssociation {
  regionLabel: RegionLabel;
  seqId: number;
  residues?: string;
}

export interface ExtractedPatent {
  patentNumber: string | null;
  sequences: ExtractedSequence[];
  associations: RegionAssociation[];
}

export const REGION_LABELS = [
  'VH', 'VL', 'CDR-H1', 'CDR-H2', 'CDR-H3', 'CDR-L1', 'CDR-L2', 'CDR-L3',
  'FR-H1', 'FR-H2', 'FR-H3', 'FR-H4', 'FR-L1', 'FR-L2', 'FR-L3', 'FR-L4',
  'Fc', 'CH1', 'CL', 'hinge', 'heavy-chain', 'light-chain', 'Fab',
] as const;

const AssocSchema = z.object({
  associations: z.array(z.object({ regionLabel: z.enum(REGION_LABELS), seqId: z.number().int().positive() })),
});

const SYSTEM =
  'You extract antibody region-to-SEQ-ID mappings from patent text. For each place the text maps an antibody region designation (VH, VL, CDR-H1/2/3, CDR-L1/2/3, Fc, Fab, heavy chain, light chain, and similar) to a SEQ ID NO, output { regionLabel, seqId }. Only output mappings explicitly stated in the text. Never transcribe or output sequences.';

const INPUT_CAP = 50000;

// Patents can exceed the model context; bound the input and prefer the claims window where associations live.
export function boundForClaims(markdown: string): string {
  const idx = markdown.search(/^\s*#*\s*claims\s*$/im);
  const start = idx >= 0 ? idx : 0;
  return markdown.slice(start, start + INPUT_CAP);
}

export async function extractAssociations(
  markdown: string,
  model: StructuredModel,
): Promise<Array<{ regionLabel: RegionLabel; seqId: number }>> {
  try {
    const out = await model.generateStructured({
      system: SYSTEM,
      prompt: boundForClaims(markdown),
      schema: AssocSchema,
      model: MODEL_ROUTER.specialist,
    });
    return out.associations;
  } catch {
    return [];
  }
}

export async function extractPatentData(markdown: string, model: StructuredModel): Promise<ExtractedPatent> {
  const patentNumber = extractPatentNumber(markdown);
  const sequences = extractSequenceListing(markdown);
  const associations = await extractAssociations(markdown, model);
  const byId = new Map(sequences.map((s) => [s.seqId, s.residues]));
  return {
    patentNumber,
    sequences,
    associations: associations.map((a) => ({ ...a, residues: byId.get(a.seqId) })),
  };
}
