import { describe, it, expect } from 'vitest';
import { readFigures, normalizeNumeric, captionContainsValue } from './figureRead.js';
import fixture from './fixtures/figures-analyze.fixture.json' with { type: 'json' };

const captionWith062 = 'Forest plot of overall survival. Pooled HR 0.620 (95% CI 0.48-0.79).';

const figures = [{
  figureId: 'PMCID:PMC7897327#fig-0',
  imageUrl: 'https://example/bin/g002',
  caption: captionWith062, // contains 0.620 (matches 0.62), does NOT contain 0.41
}];

const fixtureFetch = (async () => new Response(JSON.stringify(fixture), { status: 200 })) as unknown as typeof fetch;

describe('normalizeNumeric', () => {
  it('drops trailing zeros so 0.620 matches 0.62', () => {
    expect(normalizeNumeric('0.620')).toBe(normalizeNumeric('0.62'));
  });
  it('normalizes middle-dot and thousands separators', () => {
    expect(captionContainsValue('value 1,234 seen', '1234')).toBe(true);
    expect(captionContainsValue('ratio 0·62 shown', '0.62')).toBe(true);
  });
});

describe('readFigures', () => {
  it('derives readRisk: low for a caption-anchored value, high for a pixel-only value', async () => {
    const out = await readFigures({ question: 'survival benefit?', figures, fetchImpl: fixtureFetch });
    expect(out).toHaveLength(1);
    const vals = out[0].extractedValues;
    const hr = vals.find((v) => v.value === '0.62')!;
    const sub = vals.find((v) => v.value === '0.41')!;
    expect(hr.inCaption).toBe(true);
    expect(hr.readRisk).toBe('low');
    expect(sub.inCaption).toBe(false);
    expect(sub.readRisk).toBe('high');
    expect(out[0].evidenceId).toBe('PMCID:PMC7897327#fig-0');
  });

  it('throws on non-OK HTTP', async () => {
    const bad = (async () => new Response('x', { status: 502 })) as unknown as typeof fetch;
    await expect(readFigures({ question: 'q', figures, fetchImpl: bad })).rejects.toThrow(/HTTP 502/);
  });

  it('drops a reading whose figureId was not sent (grounding: ids set in code)', async () => {
    const rogue = { readings: [{ figureId: 'PMCID:PMCX#fig-9', relevanceScore: 1, reading: 'r', extractedValues: [], confidence: 0.5 }] };
    const rogueFetch = (async () => new Response(JSON.stringify(rogue), { status: 200 })) as unknown as typeof fetch;
    const out = await readFigures({ question: 'q', figures, fetchImpl: rogueFetch });
    expect(out).toEqual([]);
  });

  it('returns [] with no network call for empty figures', async () => {
    let called = false;
    const spyFetch = (async () => { called = true; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    expect(await readFigures({ question: 'q', figures: [], fetchImpl: spyFetch })).toEqual([]);
    expect(called).toBe(false);
  });
});
