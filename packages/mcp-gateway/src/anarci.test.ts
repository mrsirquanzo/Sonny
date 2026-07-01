import { describe, it, expect } from 'vitest';
import {
  normalizeSeq, deriveRegions, matchRegion, isConstantLabel, anchorChainFor, confirmRegions,
} from './anarci.js';
import type { Numbering } from './anarci.js';
import type { Exec } from './anarci.js';

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

// Bridge output for a heavy domain: human germline, CDR-H1 = GFS, CDR-H3 = ARGYDSFDY (with inserts).
const HEAVY_BRIDGE = JSON.stringify({
  status: 'ok',
  domains: [{
    inputId: 'vh', chain: 'H', species: 'homo_sapiens',
    germline: { v: 'IGHV3-23*01', j: 'IGHJ4*02' },
    numbering: [
      ['27', 'G'], ['28', 'F'], ['38', 'S'],
      ['105', 'A'], ['106', 'R'], ['111', 'G'], ['111A', 'Y'], ['111B', 'D'],
      ['112B', 'S'], ['112A', 'F'], ['112', 'D'], ['117', 'Y'],
    ],
  }],
});
const MOUSE_KAPPA_BRIDGE = JSON.stringify({
  status: 'ok',
  domains: [{
    inputId: 'vl', chain: 'K', species: 'mus_musculus',
    germline: { v: 'IGKV4-1*01', j: 'IGKJ1*01' },
    numbering: [['27', 'Q'], ['28', 'S'], ['38', 'L']],
  }],
});
const execReturning = (stdout: string): Exec => (async () => ({ stdout, stderr: '', code: 0 }));

describe('confirmRegions', () => {
  it('confirms a matching CDR-H1 and derives the insertion-coded CDR-H3', async () => {
    const out = await confirmRegions(
      { vh: 'EVQ', claimedRegions: [{ label: 'CDR-H1', sequence: 'GFS' }, { label: 'CDR-H3', sequence: 'ARGYDSFDY' }] },
      { exec: execReturning(HEAVY_BRIDGE) },
    );
    expect(out.overallStatus).toBe('confirmed');
    expect(out.regionChecks.find((c) => c.label === 'CDR-H1')?.status).toBe('confirmed');
    expect(out.regionChecks.find((c) => c.label === 'CDR-H3')?.status).toBe('confirmed');
    const vh = out.domains[0].numberedRegions.VH;
    expect(vh?.residues.some((r) => r.pos === '111A')).toBe(true); // insertion code preserved end to end
    expect(out.speciesSummary).toEqual([{ chain: 'H', species: 'homo_sapiens' }]);
  });

  it('reports a mismatch with both sequences', async () => {
    const out = await confirmRegions(
      { vh: 'EVQ', claimedRegions: [{ label: 'CDR-H1', sequence: 'GFT' }] },
      { exec: execReturning(HEAVY_BRIDGE) },
    );
    expect(out.overallStatus).toBe('mismatch');
    const check = out.regionChecks[0];
    expect(check.status).toBe('mismatch');
    expect(check.derivedSeq).toBe('GFS');
    expect(check.claimedSeq).toBe('GFT');
  });

  it('reports the non-human species and kappa chain for a murine light domain', async () => {
    const out = await confirmRegions(
      { vl: 'QSV', claimedRegions: [] },
      { exec: execReturning(MOUSE_KAPPA_BRIDGE) },
    );
    expect(out.domains[0].chain).toBe('K');
    expect(out.speciesSummary).toEqual([{ chain: 'K', species: 'mus_musculus' }]);
  });

  it('flags an orphan CDR (no anchor domain) as orphan_unverifiable', async () => {
    const out = await confirmRegions(
      { claimedRegions: [{ label: 'CDR-H1', sequence: 'GFS' }] },
      { exec: execReturning(JSON.stringify({ status: 'ok', domains: [] })) },
    );
    expect(out.regionChecks[0].status).toBe('orphan_unverifiable');
  });

  it('flags a constant-region claim as not_applicable_constant', async () => {
    const out = await confirmRegions(
      { vh: 'EVQ', claimedRegions: [{ label: 'Fc', sequence: 'DKTHT' }] },
      { exec: execReturning(HEAVY_BRIDGE) },
    );
    expect(out.regionChecks[0].status).toBe('not_applicable_constant');
  });

  it('soft-degrades to anarci_unavailable without throwing', async () => {
    const out = await confirmRegions(
      { vh: 'EVQ', claimedRegions: [{ label: 'CDR-H1', sequence: 'GFS' }] },
      { exec: execReturning(JSON.stringify({ status: 'anarci_unavailable', error: 'no module named anarci' })) },
    );
    expect(out.overallStatus).toBe('anarci_unavailable');
    expect(out.regionChecks[0].status).toBe('anarci_unavailable');
    expect(out.domains).toEqual([]);
  });

  it('throws on unparseable bridge stdout', async () => {
    await expect(
      confirmRegions(
        { vh: 'EVQ', claimedRegions: [] },
        { exec: execReturning('WARNING: rogue line\n{not json}') },
      ),
    ).rejects.toThrow(/unparseable/);
  });

  it('handles an all-gap VH domain without Infinity bounds', async () => {
    const allGapBridge = JSON.stringify({
      status: 'ok',
      domains: [{
        inputId: 'vh', chain: 'H', species: 'homo_sapiens',
        germline: { v: 'IGHV3-23*01', j: 'IGHJ4*02' },
        numbering: [['1', '-'], ['2', '-']],
      }],
    });
    const out = await confirmRegions(
      { vh: 'XX', claimedRegions: [] },
      { exec: execReturning(allGapBridge) },
    );
    const vh = out.domains[0].numberedRegions.VH;
    expect(vh?.seq).toBe('');
    expect(vh?.imgtStart).toBe(0);
    expect(vh?.imgtEnd).toBe(0);
  });
});
