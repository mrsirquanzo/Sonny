import { describe, it, expect, vi } from 'vitest';
import type { Claim, TraceEvent } from '@mrsirquanzo/sonny-shared';
import { EvidenceStore } from '../evidenceStore.js';
import type { StructuredModel } from '../model.js';
import { detectContradictions } from './consistency.js';

function claim(id: string, cite: string): Claim {
  return { id, text: `finding ${id}`, citations: [cite], confidence: 0.8 };
}
function storeWith(...ids: string[]): EvidenceStore {
  const s = new EvidenceStore();
  for (const id of ids) s.register({ id, kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' });
  return s;
}
const claims = [claim('c1', 'PMID:1'), claim('c2', 'PMID:2')];

describe('detectContradictions', () => {
  it('returns valid grounded flags and emits a contradiction event each', async () => {
    const events: TraceEvent[] = [];
    const model: StructuredModel = {
      async generateStructured() {
        return { contradictions: [{ evidenceIdA: 'PMID:1', evidenceIdB: 'PMID:2', endpoint: 'OS', explanation: 'opposite' }] } as never;
      },
    };
    const out = await detectContradictions({ claims, store: storeWith('PMID:1', 'PMID:2'), model, emit: (e) => events.push(e) });
    expect(out).toHaveLength(1);
    expect(events.filter((e) => e.type === 'contradiction')).toHaveLength(1);
  });

  it('drops a flag whose id is not in the store, and a same-id flag', async () => {
    const model: StructuredModel = {
      async generateStructured() {
        return { contradictions: [
          { evidenceIdA: 'PMID:1', evidenceIdB: 'PMID:999', endpoint: 'x', explanation: 'y' },
          { evidenceIdA: 'PMID:1', evidenceIdB: 'PMID:1', endpoint: 'x', explanation: 'y' },
        ] } as never;
      },
    };
    const out = await detectContradictions({ claims, store: storeWith('PMID:1', 'PMID:2'), model, emit: () => {} });
    expect(out).toEqual([]);
  });

  it('degrades to [] and emits an error when the model throws', async () => {
    const events: TraceEvent[] = [];
    const model: StructuredModel = { async generateStructured() { throw new Error('boom'); } };
    const out = await detectContradictions({ claims, store: storeWith('PMID:1', 'PMID:2'), model, emit: (e) => events.push(e) });
    expect(out).toEqual([]);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('returns [] without calling the model for fewer than two claims', async () => {
    const gen = vi.fn();
    const out = await detectContradictions({ claims: [claim('c1', 'PMID:1')], store: storeWith('PMID:1'), model: { generateStructured: gen } as never, emit: () => {} });
    expect(out).toEqual([]);
    expect(gen).not.toHaveBeenCalled();
  });
});
