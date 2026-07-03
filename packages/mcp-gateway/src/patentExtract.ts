import { normalizePatentNumber } from './epoPatent.js';
import { XMLParser } from 'fast-xml-parser';
import type { RegionLabel } from './anarci.js';

export interface ExtractedSequence {
  seqId: number;
  residues: string;
  declaredLength?: number;
}

// Candidate patent-number strings: 2-letter country, digits (with interior spaces/commas/dots/slashes), optional kind code.
const CANDIDATE = /[A-Z]{2}[  ]?\d[\d,.\s/]{2,}\d(?:[  ]?[A-Z]\d?)?/g;

export function extractPatentNumber(markdown: string): string | null {
  const candidates = markdown.match(CANDIDATE) ?? [];
  for (const c of candidates) {
    const norm = normalizePatentNumber(c.replace(/\//g, ''));
    if (norm) return norm.epodoc;
  }
  return null;
}

function normalizeResidues(raw: string): string {
  return raw.replace(/[^A-Za-z]/g, '').toUpperCase();
}

// ST.25 numeric identifiers: <210> is the SEQ ID number, <211> is its length.
// Pair them when <211> follows <210> within a small window (the <212>/<213> lines may sit between).
function declaredLengths(markdown: string): Map<number, number> {
  const re = /<210>\s*(\d+)(?:(?!<210>)[\s\S]){0,80}?<211>\s*(\d+)/g;
  const out = new Map<number, number>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const id = Number(m[1]);
    if (!out.has(id)) out.set(id, Number(m[2]));
  }
  return out;
}

// Capture the residue block that follows each "SEQ ID NO: N". Group 2 starts with an uppercase
// letter and runs over uppercase/digit/whitespace until the next SEQ ID marker, a blank line, or end.
// Inline references (followed by lowercase prose) do not match group 2 and are skipped.
// The regex is constructed inside the function so its /g lastIndex never leaks across calls.
export function extractSequenceListing(markdown: string): ExtractedSequence[] {
  const listing = /SEQ\s*ID\s*NO[:.\s]*?(\d+)\s*[:.)\-]?\s*\n?([A-Z][A-Z0-9\s]*?)(?=SEQ\s*ID\s*NO|\n\s*\n|$)/g;
  const lengths = declaredLengths(markdown);
  const out: ExtractedSequence[] = [];
  const seen = new Set<number>();
  let m: RegExpExecArray | null;
  while ((m = listing.exec(markdown)) !== null) {
    const seqId = Number(m[1]);
    if (seen.has(seqId)) continue;
    const residues = normalizeResidues(m[2]);
    if (residues.length < 4) continue;
    seen.add(seqId);
    const declaredLength = lengths.get(seqId);
    out.push(declaredLength !== undefined ? { seqId, residues, declaredLength } : { seqId, residues });
  }
  return out;
}

export function isST26(content: string): boolean {
  return /<ST26SequenceListing|<INSDSeq_sequence>/.test(content);
}

const st26Parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false });

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

export function extractSequenceListingST26(content: string): ExtractedSequence[] {
  let parsed: unknown;
  try { parsed = st26Parser.parse(content); } catch { return []; }
  const root = (parsed as { ST26SequenceListing?: { SequenceData?: unknown } })?.ST26SequenceListing;
  const data = asArray(root?.SequenceData) as Array<Record<string, unknown>>;
  const out: ExtractedSequence[] = [];
  const seen = new Set<number>();
  for (const d of data) {
    const seqId = Number(d['@_sequenceIDNumber']);
    if (!Number.isInteger(seqId) || seen.has(seqId)) continue;
    const insd = (d.INSDSeq ?? {}) as Record<string, unknown>;
    const residues = normalizeResidues(String(insd.INSDSeq_sequence ?? ''));
    if (residues.length < 4) continue;
    const len = Number(insd['INSDSeq_length']);
    seen.add(seqId);
    out.push(Number.isInteger(len) ? { seqId, residues, declaredLength: len } : { seqId, residues });
  }
  return out;
}

export function extractSequences(content: string): ExtractedSequence[] {
  return isST26(content) ? extractSequenceListingST26(content) : extractSequenceListing(content);
}

export function normalizeRegionNote(note: string): RegionLabel | undefined {
  const n = note.toLowerCase();
  const heavy = /heavy|\bhc\b|\bvh\b|hcdr|\bh[- ]?cdr|\bfr[- ]?h/.test(n);
  const light = /light|\blc\b|\bvl\b|lcdr|\bl[- ]?cdr|\bfr[- ]?l|kappa|lambda/.test(n);
  const cdr = n.match(/cdr[- ]?[hl]?[- ]?([123])\b/) ?? n.match(/[hl]cdr[- ]?([123])\b/) ?? n.match(/cdr\D*?([123])\b/);
  if (/cdr/.test(n) && cdr) {
    const num = cdr[1];
    const chainLetter = n.match(/([hl])[- ]?cdr/) ?? n.match(/cdr[- ]?([hl])(?=\d|\W|$)/);
    const isH = heavy || chainLetter?.[1] === 'h';
    const isL = light || chainLetter?.[1] === 'l';
    if (isH && !isL) return `CDR-H${num}` as RegionLabel;
    if (isL && !isH) return `CDR-L${num}` as RegionLabel;
    return undefined;
  }
  if (/variable|\bvh\b|\bvl\b|\bfv\b/.test(n)) {
    if (heavy && !light) return 'VH';
    if (light && !heavy) return 'VL';
    return undefined;
  }
  if (/\bfab\b/.test(n)) return 'Fab';
  if (/\bfc\b/.test(n)) return 'Fc';
  if (/\bch1\b/.test(n)) return 'CH1';
  if (/\bcl\b|constant light/.test(n)) return 'CL';
  if (/hinge/.test(n)) return 'hinge';
  if (/chain/.test(n)) {
    if (heavy && !light) return 'heavy-chain';
    if (light && !heavy) return 'light-chain';
  }
  return undefined;
}
