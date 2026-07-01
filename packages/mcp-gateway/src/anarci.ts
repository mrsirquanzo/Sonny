import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

export type Exec = (scriptPath: string, stdin: string) => Promise<{ stdout: string; stderr: string; code: number }>;

interface BridgeDomain {
  inputId: string;
  chain: 'H' | 'K' | 'L';
  species: string;
  germline: { v: string; j: string };
  numbering: Numbering;
}
interface BridgeOutput { status: 'ok' | 'anarci_unavailable'; error?: string; domains?: BridgeDomain[] }

const SCRIPT_PATH = fileURLToPath(new URL('./anarci_confirm.py', import.meta.url));

const defaultExec: Exec = (scriptPath, stdin) =>
  new Promise((resolve, reject) => {
    const py = process.env.SONNY_PYTHON ?? 'python3';
    const child = spawn(py, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    child.stdin.write(stdin);
    child.stdin.end();
  });

function fullDomainRegion(numbering: Numbering): NumberedRegion {
  const residues = numbering.filter(([, aa]) => aa !== '-' && aa !== '').map(([pos, aa]) => ({ pos, aa }));
  const nums = residues.map((r) => parseInt(r.pos, 10));
  return { seq: residues.map((r) => r.aa).join(''), imgtStart: Math.min(...nums), imgtEnd: Math.max(...nums), residues };
}

function labelRegions(numbering: Numbering, chain: 'H' | 'K' | 'L'): Partial<Record<RegionLabel, NumberedRegion>> {
  const generic = deriveRegions(numbering);
  const suffix = chain === 'H' ? 'H' : 'L';
  const out: Partial<Record<RegionLabel, NumberedRegion>> = {};
  out[chain === 'H' ? 'VH' : 'VL'] = fullDomainRegion(numbering);
  for (const [key, region] of Object.entries(generic)) {
    const m = key.match(/^(CDR|FR)([1-4])$/);
    if (m) out[`${m[1]}-${suffix}${m[2]}` as RegionLabel] = region;
  }
  return out;
}

function checkRegion(
  claim: { label: RegionLabel; sequence: string },
  domains: ConfirmedDomain[],
): RegionCheck {
  if (isConstantLabel(claim.label)) {
    return { label: claim.label, claimedSeq: claim.sequence, status: 'not_applicable_constant' };
  }
  const anchor = anchorChainFor(claim.label);
  const domain = domains.find((d) => (anchor === 'H' ? d.chain === 'H' : d.chain === 'K' || d.chain === 'L'));
  if (!domain) {
    return { label: claim.label, claimedSeq: claim.sequence, status: 'orphan_unverifiable', note: 'no variable-domain anchor to number' };
  }
  const derived = domain.numberedRegions[claim.label];
  if (!derived) {
    return { label: claim.label, claimedSeq: claim.sequence, status: 'orphan_unverifiable', note: 'region not present in numbered domain' };
  }
  const ok = matchRegion(claim.sequence, derived.seq);
  return { label: claim.label, claimedSeq: claim.sequence, derivedSeq: derived.seq, status: ok ? 'confirmed' : 'mismatch' };
}

function computeOverall(checks: RegionCheck[]): RegionConfirmation['overallStatus'] {
  if (checks.length === 0) return 'confirmed';
  if (checks.some((c) => c.status === 'mismatch')) return 'mismatch';
  if (checks.every((c) => c.status === 'confirmed')) return 'confirmed';
  return 'partial';
}

export async function confirmRegions(
  input: ConfirmInput,
  deps: { exec?: Exec } = {},
): Promise<RegionConfirmation> {
  const exec = deps.exec ?? defaultExec;
  const scheme = input.scheme ?? 'imgt';

  const sequences: Array<{ id: string; seq: string }> = [];
  if (input.vh) sequences.push({ id: 'vh', seq: normalizeSeq(input.vh) });
  if (input.vl) sequences.push({ id: 'vl', seq: normalizeSeq(input.vl) });

  let bridge: BridgeOutput;
  if (sequences.length === 0) {
    bridge = { status: 'ok', domains: [] };
  } else {
    const { stdout, code } = await exec(SCRIPT_PATH, JSON.stringify({ sequences, scheme }));
    try {
      bridge = JSON.parse(stdout) as BridgeOutput;
    } catch {
      throw new Error(`anarci bridge: unparseable stdout (exit ${code})`);
    }
  }

  if (bridge.status === 'anarci_unavailable') {
    return {
      overallStatus: 'anarci_unavailable',
      domains: [],
      regionChecks: input.claimedRegions.map((r) => ({ label: r.label, claimedSeq: r.sequence, status: 'anarci_unavailable' as const })),
      speciesSummary: [],
    };
  }

  const domains: ConfirmedDomain[] = (bridge.domains ?? []).map((d) => ({
    chain: d.chain,
    species: d.species,
    germline: d.germline,
    numberedRegions: labelRegions(d.numbering, d.chain),
  }));
  const speciesSummary = domains.map((d) => ({ chain: d.chain, species: d.species }));
  const regionChecks = input.claimedRegions.map((r) => checkRegion(r, domains));

  return { overallStatus: computeOverall(regionChecks), domains, regionChecks, speciesSummary };
}
