import { z } from 'zod';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';
import { REGION_LABELS, boundForClaims } from './patentData.js';
import type { RegionAssociation, ExtractedPatent } from './patentData.js';
import type { RegionLabel, PatentRecord } from '@mrsirquanzo/sonny-mcp-gateway';
import type { Evidence } from '@mrsirquanzo/sonny-shared';
import { toBlastHit } from './patentReconcile.js';
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
  patentMatches?: BlastHit[];
}

export type SpeciesClass = 'human-like' | 'chimeric' | 'murine' | 'unknown';
export interface SpeciesCall {
  classification: SpeciesClass;
  variableSpecies?: string;
  constantSpecies?: string;
  evidence: string;
}

export interface WorkedConstruct { name: string; regions: WorkedRegion[]; species: SpeciesCall; pairingWarning?: string; cdrCompetitors?: BlastHit[] }

export type ClaimVerdict = 'supported' | 'unsupported' | 'overreach' | 'unverified';
export interface IpPoint { point: string; citations: string[]; verdict?: ClaimVerdict; verdictRationale?: string }
export interface CompetitiveIP { summary: string; points: IpPoint[]; decorrelated?: boolean; verified?: boolean }

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
  disclosureShape?: 'antibody' | 'not-standard-antibody';
}

const ConstructsSchema = z.object({
  constructs: z.array(z.object({
    name: z.string(),
    members: z.array(z.object({ regionLabel: z.enum(REGION_LABELS), seqId: z.number().int().positive() })),
  })),
});

const GROUP_SYSTEM =
  'You group a patent\'s disclosed antibody regions into distinct antibody constructs. Read the claims and the region-to-SEQ-ID associations. For each antibody the patent defines, output its name (or a label like "Antibody 1") and the members (regionLabel + seqId) that belong to it. Only use SEQ-IDs present in the associations. Never invent sequences or SEQ-IDs.';

function pairingWarningFor(chains: Array<'H' | 'K' | 'L'>): string | undefined {
  if (chains.length === 0) return undefined; // no numbered domain -> handled by disclosureShape
  const heavy = chains.filter((c) => c === 'H').length;
  const light = chains.filter((c) => c === 'K' || c === 'L').length;
  if (heavy === 1 && light === 1) return undefined;
  if (heavy > 1) return 'two or more heavy chains grouped into one construct';
  if (light > 1) return 'two or more light chains grouped into one construct';
  if (heavy === 1 && light === 0) return 'heavy chain with no paired light chain';
  if (light === 1 && heavy === 0) return 'light chain with no paired heavy chain';
  return undefined;
}

function normalizeResidues(s: string): string {
  return s.replace(/[^A-Za-z]/g, '').toUpperCase();
}

function isCdr(label: RegionLabel): boolean {
  return /^CDR-[HL][1-3]$/.test(label);
}

const CONSTANT_LABELS: RegionLabel[] = ['Fc', 'CH1', 'CL', 'hinge', 'heavy-chain', 'light-chain', 'Fab'];

function classifySpecies(variableSpecies?: string, constantSpecies?: string): SpeciesClass {
  const human = (s?: string) => !!s && /homo|human/i.test(s);
  const nonHuman = (s?: string) => !!s && /mus|mouse|rat|rabbit|rhesus|macaca/i.test(s);
  if (human(variableSpecies) && (human(constantSpecies) || !constantSpecies)) return 'human-like';
  if (nonHuman(variableSpecies) && human(constantSpecies)) return 'chimeric';
  if (nonHuman(variableSpecies) && (nonHuman(constantSpecies) || !constantSpecies)) return 'murine';
  return 'unknown';
}

export function buildWorkup(
  extracted: ExtractedPatent,
  reconciliation: PatentReconciliation,
  constructs: AntibodyConstruct[],
): PatentWorkup {
  const bySeq = new Map<number, VerifiedSequence>(reconciliation.sequences.map((s) => [s.seqId, s]));
  const assigned = new Set<number>();

  const workedConstructs: WorkedConstruct[] = constructs.map((c) => {
    const vhSeq = c.members.filter((m) => m.regionLabel === 'VH').map((m) => bySeq.get(m.seqId)).find(Boolean);
    const vlSeq = c.members.filter((m) => m.regionLabel === 'VL').map((m) => bySeq.get(m.seqId)).find(Boolean);
    const derived = vhSeq?.domain?.numberedRegions;

    const regions: WorkedRegion[] = c.members.filter((m) => bySeq.has(m.seqId)).map((m) => {
      assigned.add(m.seqId);
      const vs = bySeq.get(m.seqId);
      const residues = vs?.residues ?? '';
      const region: WorkedRegion = { regionLabel: m.regionLabel, seqId: m.seqId, residues, blast: vs?.nrTopHit, patentMatches: vs?.patentHits };
      if (isCdr(m.regionLabel)) {
        const d = derived?.[m.regionLabel];
        region.cdrConfirmation = !d ? 'no_anchor' : normalizeResidues(residues) === normalizeResidues(d.seq) ? 'confirmed' : 'mismatch';
      }
      return region;
    });

    const variableSpecies = (vhSeq ?? vlSeq)?.domain?.species;
    const constantMember = c.members.find((m) => CONSTANT_LABELS.includes(m.regionLabel));
    const constantSpecies = constantMember ? bySeq.get(constantMember.seqId)?.nrTopHit?.organism || undefined : undefined;
    const classification = classifySpecies(variableSpecies, constantSpecies);
    const species: SpeciesCall = {
      classification,
      variableSpecies,
      constantSpecies,
      evidence: `variable domain species ${variableSpecies ?? 'unknown'}; constant region species ${constantSpecies ?? 'unknown'}`,
    };

    const chainBySeq = new Map<number, 'H' | 'K' | 'L'>();
    for (const m of c.members) {
      const ch = bySeq.get(m.seqId)?.domain?.chain;
      if (ch) chainBySeq.set(m.seqId, ch);
    }
    const pairingWarning = pairingWarningFor([...chainBySeq.values()]);

    return { name: c.name, regions, species, pairingWarning };
  });

  const ungrouped = reconciliation.sequences.filter((s) => !assigned.has(s.seqId));

  const anyDomain = constructs.some((c) => c.members.some((m) => bySeq.get(m.seqId)?.domain !== undefined));
  const disclosureShape: PatentWorkup['disclosureShape'] = anyDomain ? 'antibody' : 'not-standard-antibody';

  return {
    patentNumber: extracted.patentNumber,
    patent: reconciliation.patent,
    constructs: workedConstructs,
    ungrouped,
    narrative: { summary: '', points: [] },
    graph: [],
    disclosureShape,
  };
}

const IpSchema = z.object({
  summary: z.string(),
  points: z.array(z.object({ point: z.string(), citations: z.array(z.string()) })),
});

const IP_SYSTEM =
  'You are a competitive-IP analyst writing a grounded summary of an antibody patent. Base every statement ONLY on the provided facts. Cover ownership and legal status, what the disclosed molecules are, their humanness, and any competitor patents that disclose the same or near-identical sequences. Explicitly flag any near-match (a mismatch count greater than zero) as a potential deliberate mutation or transcription error - never assert it is identical. Every point must cite the SEQ-ID (as "SEQ:<n>") or competitor accession it rests on, copied verbatim.';

export async function synthesizeCompetitiveIP(workup: PatentWorkup, model: StructuredModel): Promise<CompetitiveIP> {
  const knownCitations = new Set<string>();
  for (const c of workup.constructs) {
    for (const r of c.regions) {
      knownCitations.add(`SEQ:${r.seqId}`);
      if (r.blast) knownCitations.add(r.blast.accession);
      for (const h of r.patentMatches ?? []) knownCitations.add(h.accession);
    }
  }
  for (const s of workup.ungrouped) knownCitations.add(`SEQ:${s.seqId}`);

  const facts = [
    `Patent: ${workup.patentNumber ?? 'unknown'} (found: ${workup.patent.found}); applicants: ${workup.patent.applicants.join(', ') || 'unknown'}.`,
    ...workup.constructs.map((c) =>
      `Construct ${c.name} [${c.species.classification}]: ` +
      c.regions.map((r) => `${r.regionLabel}=SEQ:${r.seqId}${r.cdrConfirmation ? `(${r.cdrConfirmation})` : ''}${r.blast ? `, top hit ${r.blast.accession} ${r.blast.percentIdentity}% mismatches=${r.blast.mismatchCount}` : ''}${r.patentMatches && r.patentMatches.length > 0 ? `; competitor hits: ${r.patentMatches.map((h) => `${h.accession} ${h.percentIdentity}% mismatches=${h.mismatchCount}`).join(', ')}` : ''}`).join('; ')),
  ].join('\n');

  try {
    const draft = await model.generateStructured({ system: IP_SYSTEM, prompt: `FACTS:\n${facts}\n\nWrite the summary and cited points.`, schema: IpSchema, model: MODEL_ROUTER.writer });
    return {
      summary: draft.summary,
      points: draft.points.map((p) => ({ point: p.point, citations: p.citations.filter((c) => knownCitations.has(c)) })),
    };
  } catch {
    return { summary: 'Competitive-IP narrative unavailable (synthesis failed).', points: [] };
  }
}

const CDRH3_MIN_IDENTITY = 90;

export type CdrBlast = (
  sequence: string,
  database: string,
  opts?: { wordSize?: number; matrix?: string; expect?: number },
) => Promise<Evidence[]>;

export async function matchCdrCompetitors(
  workup: PatentWorkup,
  reconciliation: PatentReconciliation,
  blast: CdrBlast,
): Promise<void> {
  const bySeq = new Map<number, VerifiedSequence>(reconciliation.sequences.map((s) => [s.seqId, s]));
  for (const c of workup.constructs) {
    const vhSeqId = c.regions.find((r) => r.regionLabel === 'VH')?.seqId;
    const cdrh3 = vhSeqId !== undefined ? bySeq.get(vhSeqId)?.domain?.numberedRegions?.['CDR-H3']?.seq : undefined;
    if (!cdrh3) continue;
    try {
      const hits = await blast(cdrh3, 'pataa', { wordSize: 2, matrix: 'PAM30', expect: 200000 });
      c.cdrCompetitors = hits
        .map((h) => toBlastHit(h, 'pataa'))
        .filter((h): h is BlastHit => h !== undefined && h.percentIdentity >= CDRH3_MIN_IDENTITY);
    } catch {
      c.cdrCompetitors = [];
    }
  }
}

export function graphRelationships(workup: PatentWorkup): Relationship[] {
  const edges: Relationship[] = [];
  const subject = workup.patentNumber ?? workup.patent.input ?? 'unknown-patent';

  if (workup.patent.found) {
    for (const company of workup.patent.applicants) {
      edges.push({ subject, predicate: 'OWNED_BY', object: company, provenance: 'epo-assignee', confidence: 'verified' });
    }
  }

  const seen = new Set<number>();
  const addDisclose = (seqId: number) => {
    if (seen.has(seqId)) return;
    seen.add(seqId);
    edges.push({ subject, predicate: 'DISCLOSES', object: `SEQ:${seqId}`, provenance: 'patent-listing', confidence: 'claimed' });
  };

  for (const c of workup.constructs) {
    for (const r of c.regions) {
      addDisclose(r.seqId);
      edges.push({ subject: c.name, predicate: 'HAS_REGION', object: `SEQ:${r.seqId}`, provenance: 'claims-grouping', confidence: 'claimed' });
      for (const hit of r.patentMatches ?? []) {
        edges.push({ subject: `SEQ:${r.seqId}`, predicate: 'MATCHES', object: hit.accession, provenance: 'blast-pataa', confidence: hit.exactMatch ? 'verified' : 'claimed' });
      }
    }
    const vhSeqId = c.regions.find((r) => r.regionLabel === 'VH')?.seqId;
    if (vhSeqId !== undefined) {
      for (const hit of c.cdrCompetitors ?? []) {
        edges.push({ subject: `SEQ:${vhSeqId}`, predicate: 'MATCHES', object: hit.accession, provenance: 'blast-cdr-h3', confidence: 'claimed' });
      }
    }
  }
  for (const s of workup.ungrouped) addDisclose(s.seqId);

  return edges;
}

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
