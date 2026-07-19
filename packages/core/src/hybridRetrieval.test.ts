import { describe, expect, it } from 'vitest';
import type { Evidence, TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { StructuredModel } from './model.js';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import { reciprocalRankFusion, retrieveResearchHits } from './hybridRetrieval.js';

function hit(id: string, text = id): Evidence {
  return { id, kind: 'publication', source: 'Europe PMC', title: `CDCP1 ${text}`, snippet: '', passage: text, url: 'u', raw: {}, retrievedAt: 'now' };
}

const unusedModel: StructuredModel = { async generateStructured() { throw new Error('unused'); } };

describe('reciprocalRankFusion', () => {
  it('rewards items present across rankings and deduplicates each list', () => {
    const fused = reciprocalRankFusion(
      [{ items: ['a', 'b', 'a'] }, { items: ['b', 'c'] }],
      (value) => value,
      60,
    );
    expect(fused).toEqual(['b', 'a', 'c']);
  });
});

describe('retrieveResearchHits', () => {
  it('unions query variants, dense-ranks, RRF-fuses, and emits new trace events', async () => {
    const a = hit('PMID:1', 'generic biology');
    const b = hit('PMID:2', 'integrin mechanism');
    const c = hit('PMID:3', 'cleavage metastasis');
    const search: Tool = {
      name: 'europepmc_search', description: '',
      async call(args) {
        return String(args.query).includes('cleavage') ? [c, b] : [a, b];
      },
    };
    const events: TraceEvent[] = [];
    const out = await retrieveResearchHits({
      specialist: 'biology', target: 'CDCP1', question: 'How does cleavage cause metastasis?', concept: 'biology',
      terms: ['cdcp1'], search, model: unusedModel, emit: (event) => events.push(event), hybrid: true, topK: 3,
      rewrite: async () => [{ target: 'CDCP1', concept: 'biology' }, { target: 'CDCP1', concept: 'cleavage' }],
      embeddings: {
        model: 'mock-embed',
        async embed() { return [[1, 0], [0, 1], [0.8, 0.2], [1, 0]]; },
      },
    });
    expect(new Set(out.map((item) => item.id))).toEqual(new Set(['PMID:1', 'PMID:2', 'PMID:3']));
    expect(events.some((event) => event.type === 'query_rewrite')).toBe(true);
    expect(events.some((event) => event.type === 'dense_score')).toBe(true);
    expect(events.some((event) => event.type === 'fusion')).toBe(true);
  });

  it('falls back to the lexical union when embedding fails', async () => {
    const events: TraceEvent[] = [];
    const search: Tool = { name: 'europepmc_search', description: '', async call() { return [hit('PMID:1'), hit('PMID:2')]; } };
    const out = await retrieveResearchHits({
      specialist: 's', target: 'CDCP1', question: 'q', concept: 'biology', terms: ['cdcp1'], search,
      model: unusedModel, emit: (event) => events.push(event), hybrid: true,
      rewrite: async () => [{ target: 'CDCP1', concept: 'biology' }],
      embeddings: { model: 'broken', async embed() { throw new Error('offline'); } },
    });
    expect(out.map((item) => item.id)).toEqual(['PMID:1', 'PMID:2']);
    expect(events.some((event) => event.type === 'error' && event.message.includes('dense retrieval failed'))).toBe(true);
  });

  it('uses one lexical query when hybrid retrieval is disabled', async () => {
    let calls = 0;
    const search: Tool = { name: 'europepmc_search', description: '', async call() { calls++; return [hit('PMID:1')]; } };
    const out = await retrieveResearchHits({
      specialist: 's', target: 'CDCP1', question: 'q', concept: 'biology', terms: ['cdcp1'], search,
      model: unusedModel, emit: () => {}, hybrid: false,
    });
    expect(calls).toBe(1);
    expect(out.map((item) => item.id)).toEqual(['PMID:1']);
  });
});
