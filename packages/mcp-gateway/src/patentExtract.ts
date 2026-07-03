import { normalizePatentNumber } from './epoPatent.js';

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
  const re = /<210>\s*(\d+)[\s\S]{0,60}?<211>\s*(\d+)/g;
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
