export type SpeciesClass = 'human-like' | 'chimeric' | 'murine' | 'unknown';

export interface GoldenConstruct { name?: string; vhSeqId?: number; vlSeqId?: number; species: SpeciesClass }
export interface GoldenCompetitor { seqId: number; competitorAccession: string; level: 'whole' | 'cdr' }

export interface GoldenPatent {
  name: string;
  patentNumber: string;
  expectedAssignees: string[];
  expectedFamilyMembers: string[];
  expectedLegalDirection?: 'active' | 'inactive' | 'mixed';
  declaredSequenceCount: number;
  knownSequences: Array<{ seqId: number; residues: string }>;
  expectedConstructs: GoldenConstruct[];
  expectedCompetitorOverlaps: GoldenCompetitor[];
  mustNotAssert: string[];
  traps?: Array<'single-residue' | 'non-antibody' | 'image-or-st26'>;
  groundTruthVerified?: boolean;
}

export function extractionRecall(foundSeqIds: number[], declaredCount: number): number {
  if (declaredCount <= 0) return 1;
  const inRange = new Set(foundSeqIds.filter((n) => Number.isInteger(n) && n >= 1 && n <= declaredCount));
  return inRange.size / declaredCount;
}

export function residueFidelity(
  extracted: Array<{ seqId: number; residues: string }>,
  known: Array<{ seqId: number; residues: string }>,
): number {
  if (known.length === 0) return 1;
  const byId = new Map(extracted.map((s) => [s.seqId, s.residues.toUpperCase()]));
  const ok = known.filter((k) => byId.get(k.seqId) === k.residues.toUpperCase()).length;
  return ok / known.length;
}

export function setRecall(got: string[], expected: string[]): number {
  if (expected.length === 0) return 1;
  const g = new Set(got.map((x) => x.trim().replace(/\s+/g, ' ').toUpperCase()));
  return expected.filter((e) => g.has(e.trim().replace(/\s+/g, ' ').toUpperCase())).length / expected.length;
}

type GotConstruct = { vhSeqId?: number; vlSeqId?: number; species: SpeciesClass };

export function speciesAccuracy(got: GotConstruct[], expected: GoldenConstruct[]): number {
  if (expected.length === 0) return 1;
  const byVh = new Map(got.filter((c) => c.vhSeqId !== undefined).map((c) => [c.vhSeqId, c]));
  const ok = expected.filter((e) => e.vhSeqId !== undefined && byVh.get(e.vhSeqId)?.species === e.species).length;
  return ok / expected.length;
}

export function pairingAccuracy(got: GotConstruct[], expected: GoldenConstruct[]): number {
  if (expected.length === 0) return 1;
  const byVh = new Map(got.filter((c) => c.vhSeqId !== undefined).map((c) => [c.vhSeqId, c]));
  const ok = expected.filter((e) => {
    if (e.vhSeqId === undefined) return false;
    const match = byVh.get(e.vhSeqId);
    if (match === undefined) return false;   // no matching construct = miss
    return match.vlSeqId === e.vlSeqId;
  }).length;
  return ok / expected.length;
}

const key = (o: GoldenCompetitor) => `${o.seqId}|${o.competitorAccession}|${o.level}`;

export function competitorRecall(got: GoldenCompetitor[], expected: GoldenCompetitor[], level: 'whole' | 'cdr'): number {
  const exp = expected.filter((e) => e.level === level);
  if (exp.length === 0) return 1;
  const g = new Set(got.map(key));
  return exp.filter((e) => g.has(key(e))).length / exp.length;
}

export function competitorPrecision(got: GoldenCompetitor[], expected: GoldenCompetitor[], level: 'whole' | 'cdr'): number {
  const g = got.filter((o) => o.level === level);
  if (g.length === 0) return 1;
  const e = new Set(expected.map(key));
  return g.filter((o) => e.has(key(o))).length / g.length;
}
