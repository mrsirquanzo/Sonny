import { describe, it, expect } from 'vitest';
import {
  normalizeSeq, deriveRegions, matchRegion, isConstantLabel, anchorChainFor,
} from './anarci.js';
import type { Numbering } from './anarci.js';

// A minimal heavy-domain numbering with a CDR-H3 that carries IMGT insertion codes.
// FR-H1 covers 1-26, CDR-H1 27-38, and CDR-H3 105-117 (with 111A/111B/112B/112A inserts).
const NUMBERING: Numbering = [
  ['1', 'E'], ['2', 'V'], ['3', 'Q'], ['26', 'C'],       // FR1 (sparse is fine)
  ['27', 'G'], ['28', 'F'], ['38', 'S'],                 // CDR1
  ['105', 'A'], ['106', 'R'], ['111', 'G'], ['111A', 'Y'], ['111B', 'D'],
  ['112B', 'S'], ['112A', 'F'], ['112', 'D'], ['117', 'Y'], // CDR3 with inserts
  ['118', 'W'], ['128', 'S'],                            // FR4
];

describe('normalizeSeq', () => {
  it('uppercases and strips whitespace', () => {
    expect(normalizeSeq('  ev ql\nv ')).toBe('EVQLV');
  });
});

describe('deriveRegions', () => {
  it('buckets residues into IMGT regions and preserves insertion-code positions as strings', () => {
    const r = deriveRegions(NUMBERING);
    expect(r.CDR1.seq).toBe('GFS');
    expect(r.CDR3.seq).toBe('ARGYDSFDY');                // insert residues kept, in given order
    const posList = r.CDR3.residues.map((x) => x.pos);
    expect(posList).toEqual(['105', '106', '111', '111A', '111B', '112B', '112A', '112', '117']);
    expect(r.CDR3.residues.some((x) => x.pos === '111A' && x.aa === 'Y')).toBe(true);
    expect(r.CDR3.imgtStart).toBe(105);
    expect(r.CDR3.imgtEnd).toBe(117);
  });

  it('skips gap residues', () => {
    const r = deriveRegions([['27', 'G'], ['28', '-'], ['29', 'F']] as Numbering);
    expect(r.CDR1.seq).toBe('GF');
  });
});

describe('matchRegion', () => {
  it('matches after normalization, rejects a different sequence', () => {
    expect(matchRegion('gfs', 'GFS')).toBe(true);
    expect(matchRegion('GFT', 'GFS')).toBe(false);
  });
});

describe('label routing', () => {
  it('flags constant labels', () => {
    expect(isConstantLabel('Fc')).toBe(true);
    expect(isConstantLabel('CDR-H1')).toBe(false);
  });
  it('resolves the anchor chain a label needs', () => {
    expect(anchorChainFor('CDR-H1')).toBe('H');
    expect(anchorChainFor('VH')).toBe('H');
    expect(anchorChainFor('CDR-L2')).toBe('light');
    expect(anchorChainFor('Fc')).toBe(null);
  });
});
