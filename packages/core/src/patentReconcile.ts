import type { Evidence } from '@mrsirquanzo/sonny-shared';
import { blastVerifyTool, confirmRegions, lookupPatent } from '@mrsirquanzo/sonny-mcp-gateway';
import type { PatentRecord, RegionLabel, NumberedRegion, ConfirmInput, RegionConfirmation } from '@mrsirquanzo/sonny-mcp-gateway';
import type { ExtractedPatent } from './patentData.js';

const MIN_BLAST_LEN = 50;
const COMPETITOR_MIN_IDENTITY = 98;

export interface BlastHit {
  database: string;
  accession: string;
  title: string;
  percentIdentity: number;
  queryCoverage: number;
  mismatchCount: number;
  exactMatch: boolean;
  organism: string;
}

export interface VerifiedSequence {
  seqId: number;
  residues: string;
  regionLabels: RegionLabel[];
  length: number;
  blasted: boolean;
  nrTopHit?: BlastHit;
  patentHits: BlastHit[];
  domain?: { chain: 'H' | 'K' | 'L'; species: string; numberedRegions: Partial<Record<RegionLabel, NumberedRegion>> };
}

export interface PatentReconciliation {
  patent: PatentRecord;
  sequences: VerifiedSequence[];
}

export interface ReconcileDeps {
  blast?: (sequence: string, database: string) => Promise<Evidence[]>;
  anarci?: (input: ConfirmInput) => Promise<RegionConfirmation>;
  epo?: (input: string) => Promise<PatentRecord>;
}

export function toBlastHit(e: Evidence | undefined, database: string): BlastHit | undefined {
  if (!e) return undefined;
  const raw = e.raw as {
    accession?: string; percentIdentity?: number; queryCoverage?: number; organism?: string; identity?: number; alignLen?: number;
  };
  const percentIdentity = Number(raw.percentIdentity ?? 0);
  const queryCoverage = Number(raw.queryCoverage ?? 0);
  const alignLen = Number(raw.alignLen ?? 0);
  const identity = Number(raw.identity ?? 0);
  const mismatchCount = Math.max(0, alignLen - identity);
  return {
    database,
    accession: String(raw.accession ?? ''),
    title: e.title,
    percentIdentity,
    queryCoverage,
    mismatchCount,
    exactMatch: mismatchCount === 0 && queryCoverage === 100,
    organism: String(raw.organism ?? ''),
  };
}

function emptyPatent(input: string, error: string): PatentRecord {
  return { input, found: false, applicants: [], inventors: [], ipc: [], family: [], error };
}

export async function reconcilePatent(
  extracted: ExtractedPatent,
  deps: ReconcileDeps = {},
): Promise<PatentReconciliation> {
  const blast = deps.blast ?? ((sequence: string, database: string) => blastVerifyTool.call({ sequence, database }));
  const anarci = deps.anarci ?? ((input: ConfirmInput) => confirmRegions(input));
  const epo = deps.epo ?? ((input: string) => lookupPatent(input));

  const patent = extracted.patentNumber
    ? await epo(extracted.patentNumber)
    : emptyPatent('', 'EPO_NO_NUMBER: no patent number was extracted');

  const labelsBySeq = new Map<number, RegionLabel[]>();
  for (const a of extracted.associations) {
    const arr = labelsBySeq.get(a.seqId) ?? [];
    if (!arr.includes(a.regionLabel)) arr.push(a.regionLabel);
    labelsBySeq.set(a.seqId, arr);
  }

  const sequences = await Promise.all(
    extracted.sequences.map(async (s): Promise<VerifiedSequence> => {
      const regionLabels = labelsBySeq.get(s.seqId) ?? [];
      const length = s.residues.length;
      const blasted = length >= MIN_BLAST_LEN;

      let nrTopHit: BlastHit | undefined;
      let patentHits: BlastHit[] = [];
      if (blasted) {
        const [nrHits, patHits] = await Promise.all([blast(s.residues, 'nr'), blast(s.residues, 'pataa')]);
        nrTopHit = toBlastHit(nrHits[0], 'nr');
        patentHits = patHits
          .map((h) => toBlastHit(h, 'pataa'))
          .filter((h): h is BlastHit => h !== undefined && h.percentIdentity >= COMPETITOR_MIN_IDENTITY);
      }

      let domain: VerifiedSequence['domain'];
      const isHeavy = regionLabels.includes('VH');
      const isLight = regionLabels.includes('VL');
      if (isHeavy || isLight) {
        const conf = await anarci(isHeavy ? { vh: s.residues, claimedRegions: [] } : { vl: s.residues, claimedRegions: [] });
        const d = conf.domains[0];
        if (d) domain = { chain: d.chain, species: d.species, numberedRegions: d.numberedRegions ?? {} };
      }

      return { seqId: s.seqId, residues: s.residues, regionLabels, length, blasted, nrTopHit, patentHits, domain };
    }),
  );

  return { patent, sequences };
}
