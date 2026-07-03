import { describe, it, expect } from 'vitest';
import type { Evidence, TraceEvent } from '@mrsirquanzo/sonny-shared';
import { rerankResearchHits } from './rerankStep.js';

function hit(id: string): Evidence {
  return { id, kind: 'publication', source: 's', title: id, snippet: '', passage: '', url: 'u', raw: {}, retrievedAt: 'now' };
}
const hits = [hit('PMID:1'), hit('PMID:2'), hit('PMID:3')];

describe('rerankResearchHits', () => {
  it('reranks and emits a rerank event with before/after ids', async () => {
    const events: TraceEvent[] = [];
    const reversed = [...hits].reverse();
    const out = await rerankResearchHits({
      specialist: 's', question: 'q', hits, emit: (e) => events.push(e),
      rerank: async () => reversed,
    });
    expect(out.map((h) => h.id)).toEqual(['PMID:3', 'PMID:2', 'PMID:1']);
    const ev = events.find((e) => e.type === 'rerank') as Extract<TraceEvent, { type: 'rerank' }>;
    expect(ev.before).toEqual(['PMID:1', 'PMID:2', 'PMID:3']);
    expect(ev.after).toEqual(['PMID:3', 'PMID:2', 'PMID:1']);
  });

  it('degrades to the input hits and emits an error when rerank throws', async () => {
    const events: TraceEvent[] = [];
    const out = await rerankResearchHits({
      specialist: 's', question: 'q', hits, emit: (e) => events.push(e),
      rerank: async () => { throw new Error('rerank HTTP 500'); },
    });
    expect(out).toEqual(hits);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'rerank')).toBe(false);
  });

  it('returns hits unchanged without calling rerank when fewer than 2', async () => {
    let called = false;
    const out = await rerankResearchHits({
      specialist: 's', question: 'q', hits: [hit('PMID:1')], emit: () => {},
      rerank: async () => { called = true; return []; },
    });
    expect(out.map((h) => h.id)).toEqual(['PMID:1']);
    expect(called).toBe(false);
  });
});
