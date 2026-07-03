import { describe, it, expect } from 'vitest';
import type { Evidence } from '@mrsirquanzo/sonny-shared';
import { rerankHits } from './rerank.js';

function hit(id: string, title: string): Evidence {
  return { id, kind: 'publication', source: 's', title, snippet: '', passage: `${title} abstract`, url: 'u', raw: {}, retrievedAt: 'now' };
}
const hits = [hit('PMID:1', 'alpha'), hit('PMID:2', 'beta'), hit('PMID:3', 'gamma')];

function jsonFetch(payload: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status })) as unknown as typeof fetch;
}

describe('rerankHits', () => {
  it('reorders hits by descending relevance_score, mapping index back', async () => {
    // rank hit index 2 first, then 0, then 1
    const fetchImpl = jsonFetch({ results: [
      { index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.5 }, { index: 1, relevance_score: 0.1 },
    ] });
    const out = await rerankHits({ question: 'q', hits, apiKey: 'k', fetchImpl });
    expect(out.map((h) => h.id)).toEqual(['PMID:3', 'PMID:1', 'PMID:2']);
  });

  it('accepts the alternate `data` response shape', async () => {
    const fetchImpl = jsonFetch({ data: [{ index: 1, relevance_score: 0.8 }, { index: 0, relevance_score: 0.2 }, { index: 2, relevance_score: 0.1 }] });
    const out = await rerankHits({ question: 'q', hits, apiKey: 'k', fetchImpl });
    expect(out[0].id).toBe('PMID:2');
  });

  it('appends hits the response did not rank, preserving order (no candidate lost)', async () => {
    const fetchImpl = jsonFetch({ results: [{ index: 2, relevance_score: 0.9 }] });
    const out = await rerankHits({ question: 'q', hits, apiKey: 'k', fetchImpl });
    expect(out.map((h) => h.id)).toEqual(['PMID:3', 'PMID:1', 'PMID:2']);
  });

  it('drops an out-of-range index rather than fabricating a hit', async () => {
    const fetchImpl = jsonFetch({ results: [{ index: 9, relevance_score: 0.9 }, { index: 0, relevance_score: 0.5 }] });
    const out = await rerankHits({ question: 'q', hits, apiKey: 'k', fetchImpl });
    expect(out).toHaveLength(3);
    expect(out[0].id).toBe('PMID:1');
  });

  it('returns hits unchanged with no network call when fewer than 2', async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    const one = [hit('PMID:1', 'alpha')];
    expect(await rerankHits({ question: 'q', hits: one, apiKey: 'k', fetchImpl })).toEqual(one);
    expect(called).toBe(false);
  });

  it('throws when no API key is configured', async () => {
    await expect(rerankHits({ question: 'q', hits, apiKey: undefined, fetchImpl: jsonFetch({}) }))
      .rejects.toThrow(/api key/i);
  });

  it('throws on non-OK HTTP', async () => {
    await expect(rerankHits({ question: 'q', hits, apiKey: 'k', fetchImpl: jsonFetch({}, 429) }))
      .rejects.toThrow(/HTTP 429/);
  });
});
