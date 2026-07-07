import { z } from 'zod';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';
import { extractPatentNumber, extractSequences, isST26, extractST26Associations } from '@mrsirquanzo/sonny-mcp-gateway';
import type { ExtractedSequence, RegionLabel } from '@mrsirquanzo/sonny-mcp-gateway';
import type { TraceEvent } from '@mrsirquanzo/sonny-shared';

export interface ExtractionCompleteness {
  foundCount: number;
  referencedMax: number;
  missingSeqIds: number[];
  alphabetWarnings: Array<{ seqId: number; invalidChars: string }>;
  // Number of region-to-SEQ-ID associations mapped. foundCount > 0 with associationCount === 0
  // means sequences were extracted but none could be mapped to a region (a construct-less workup) -
  // the silent-degradation case worth surfacing (common for ST.26 listings lacking region features).
  associationCount: number;
}

export interface RegionAssociation {
  regionLabel: RegionLabel;
  seqId: number;
  residues?: string;
}

export interface ExtractedPatent {
  patentNumber: string | null;
  sequences: ExtractedSequence[];
  associations: RegionAssociation[];
  completeness?: ExtractionCompleteness;
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

// Standard 20 amino acids plus U (selenocysteine / RNA) and N (nucleotide ambiguity). ACGT are already AA letters.
const VALID_RESIDUES = new Set('ACDEFGHIKLMNPQRSTVWYUN'.split(''));

function computeCompleteness(
  sequences: Array<{ seqId: number; residues: string }>,
  associations: Array<{ seqId: number }>,
): ExtractionCompleteness {
  const foundIds = new Set(sequences.map((s) => s.seqId));
  const referencedMax = Math.max(0, ...sequences.map((s) => s.seqId), ...associations.map((a) => a.seqId));
  const missingSeqIds: number[] = [];
  for (let i = 1; i <= referencedMax; i++) if (!foundIds.has(i)) missingSeqIds.push(i);
  const alphabetWarnings: Array<{ seqId: number; invalidChars: string }> = [];
  // Precondition: residues are expected to be uppercase alpha-only from extractSequenceListing; uppercase defensively here.
  for (const s of sequences) {
    const invalid = [...new Set(s.residues.toUpperCase().split(''))].filter((ch) => !VALID_RESIDUES.has(ch));
    if (invalid.length > 0) alphabetWarnings.push({ seqId: s.seqId, invalidChars: invalid.join('') });
  }
  return { foundCount: sequences.length, referencedMax, missingSeqIds, alphabetWarnings, associationCount: associations.length };
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

export async function extractPatentData(
  markdown: string,
  model: StructuredModel,
  emit: (e: TraceEvent) => void = () => {},
): Promise<ExtractedPatent> {
  const patentNumber = extractPatentNumber(markdown);
  const sequences = extractSequences(markdown);
  emit({ type: 'patent_extracted', patentNumber, sequenceCount: sequences.length });
  const st26 = isST26(markdown);
  const associations = st26
    ? extractST26Associations(markdown)
    : await extractAssociations(markdown, model);
  emit({ type: 'patent_associations', associationCount: associations.length, source: st26 ? 'st26' : 'llm' });
  const byId = new Map(sequences.map((s) => [s.seqId, s.residues]));
  const completeness = computeCompleteness(sequences, associations);
  emit({ type: 'patent_complete', completeness });
  return {
    patentNumber,
    sequences,
    associations: associations.map((a) => ({ ...a, residues: byId.get(a.seqId) })),
    completeness,
  };
}
