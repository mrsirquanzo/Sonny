import { describe, it, expect } from 'vitest';
import { uniProtTargetTool } from './uniProtTarget.js';

function fakeFetch(entry: unknown): typeof fetch {
  return (async () => ({ ok: true, status: 200, json: async () => ({ results: entry ? [entry] : [] }) })) as unknown as typeof fetch;
}

describe('uniProtTargetTool', () => {
  it('emits a cell-surface localisation card for a transmembrane target', async () => {
    const out = await uniProtTargetTool.call({ symbol: 'CDCP1' }, fakeFetch({
      primaryAccession: 'Q9H5V8',
      proteinDescription: { recommendedName: { fullName: { value: 'CUB domain-containing protein 1' } } },
      comments: [{ commentType: 'SUBCELLULAR LOCATION', subcellularLocations: [{ location: { value: 'Cell membrane' } }] }],
      features: [
        { type: 'Transmembrane', location: { start: { value: 668 }, end: { value: 688 } } },
        { type: 'Topological domain', description: 'Extracellular' },
        { type: 'Domain', description: 'CUB 1' },
      ],
    }));
    const loc = out.find((e) => e.id.endsWith('#localization'));
    expect(loc).toBeTruthy();
    expect(loc!.source).toBe('UniProt');
    expect(loc!.snippet).toMatch(/cell-surface|surface|transmembrane/i);
    expect((loc!.raw as { hasExtracellularDomain: boolean }).hasExtracellularDomain).toBe(true);
    expect(out.find((e) => e.id.endsWith('#domains'))).toBeTruthy();
  });

  it('returns nothing on an empty UniProt result', async () => {
    const out = await uniProtTargetTool.call({ symbol: 'NOTAGENE' }, fakeFetch(null));
    expect(out).toEqual([]);
  });

  it('flags absence of surface topology honestly', async () => {
    const out = await uniProtTargetTool.call({ symbol: 'TP53' }, fakeFetch({
      primaryAccession: 'P04637',
      comments: [{ commentType: 'SUBCELLULAR LOCATION', subcellularLocations: [{ location: { value: 'Nucleus' } }] }],
      features: [],
    }));
    const loc = out.find((e) => e.id.endsWith('#localization'));
    expect(loc!.snippet).toMatch(/confirm surface accessibility/i);
  });
});
