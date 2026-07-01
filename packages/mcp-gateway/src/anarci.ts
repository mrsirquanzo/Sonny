export type RegionLabel =
  | 'VH' | 'VL'
  | 'CDR-H1' | 'CDR-H2' | 'CDR-H3'
  | 'CDR-L1' | 'CDR-L2' | 'CDR-L3'
  | 'FR-H1' | 'FR-H2' | 'FR-H3' | 'FR-H4'
  | 'FR-L1' | 'FR-L2' | 'FR-L3' | 'FR-L4'
  | 'Fc' | 'CH1' | 'CL' | 'hinge' | 'heavy-chain' | 'light-chain' | 'Fab';

export type Numbering = Array<[string, string]>; // [positionString, aa]; aa '-' is a gap

export interface NumberedRegion {
  seq: string;
  imgtStart: number;
  imgtEnd: number;
  residues: Array<{ pos: string; aa: string }>;
}

export interface ConfirmInput {
  vh?: string;
  vl?: string;
  claimedRegions: Array<{ label: RegionLabel; sequence: string }>;
  scheme?: 'imgt';
}

export type RegionStatus =
  | 'confirmed' | 'mismatch' | 'not_applicable_constant' | 'orphan_unverifiable' | 'anarci_unavailable';

export interface ConfirmedDomain {
  chain: 'H' | 'K' | 'L';
  species: string;
  germline: { v: string; j: string };
  numberedRegions: Partial<Record<RegionLabel, NumberedRegion>>;
}

export interface RegionCheck {
  label: RegionLabel;
  claimedSeq: string;
  derivedSeq?: string;
  status: RegionStatus;
  note?: string;
}

export interface RegionConfirmation {
  overallStatus: 'confirmed' | 'partial' | 'mismatch' | 'anarci_unavailable';
  domains: ConfirmedDomain[];
  regionChecks: RegionCheck[];
  speciesSummary: Array<{ chain: 'H' | 'K' | 'L'; species: string }>;
}

const IMGT_RANGES: Array<{ region: string; start: number; end: number }> = [
  { region: 'FR1', start: 1, end: 26 },
  { region: 'CDR1', start: 27, end: 38 },
  { region: 'FR2', start: 39, end: 55 },
  { region: 'CDR2', start: 56, end: 65 },
  { region: 'FR3', start: 66, end: 104 },
  { region: 'CDR3', start: 105, end: 117 },
  { region: 'FR4', start: 118, end: 128 },
];

const CONSTANT_LABELS: RegionLabel[] = ['Fc', 'CH1', 'CL', 'hinge', 'heavy-chain', 'light-chain', 'Fab'];

export function normalizeSeq(s: string): string {
  return s.replace(/\s+/g, '').toUpperCase();
}

function imgtNumber(pos: string): number {
  return parseInt(pos, 10); // numeric prefix; insertion letter is ignored for range bucketing only
}

export function deriveRegions(numbering: Numbering): Record<string, NumberedRegion> {
  const buckets: Record<string, Array<{ pos: string; aa: string }>> = {};
  for (const [pos, aa] of numbering) {
    if (aa === '-' || aa === '') continue;
    const n = imgtNumber(pos);
    const slot = IMGT_RANGES.find((r) => n >= r.start && n <= r.end);
    if (!slot) continue;
    (buckets[slot.region] ??= []).push({ pos, aa }); // pos preserved verbatim (insertion codes intact)
  }
  const out: Record<string, NumberedRegion> = {};
  for (const { region } of IMGT_RANGES) {
    const residues = buckets[region];
    if (!residues || residues.length === 0) continue;
    const nums = residues.map((r) => imgtNumber(r.pos));
    out[region] = {
      seq: residues.map((r) => r.aa).join(''),
      imgtStart: Math.min(...nums),
      imgtEnd: Math.max(...nums),
      residues,
    };
  }
  return out;
}

export function matchRegion(claimed: string, derived: string): boolean {
  return normalizeSeq(claimed) === normalizeSeq(derived);
}

export function isConstantLabel(label: RegionLabel): boolean {
  return CONSTANT_LABELS.includes(label);
}

export function anchorChainFor(label: RegionLabel): 'H' | 'light' | null {
  if (label === 'VH' || /-H[1-4]$/.test(label)) return 'H';
  if (label === 'VL' || /-L[1-4]$/.test(label)) return 'light';
  return null;
}
