import { describe, it, expect, vi } from 'vitest';
import type { Evidence, TraceEvent, FigureReading } from '@mrsirquanzo/sonny-shared';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import { researchFigures } from './figureStep.js';

function fakeStore() {
  const items: Evidence[] = [];
  return { register: (e: Evidence) => items.push(e), all: () => items, items } as any;
}

const figEvidence: Evidence = {
  id: 'PMCID:PMC1#fig-0', kind: 'figure', source: 'pmc', title: 'Figure 2',
  snippet: 'cap', passage: 'Pooled HR 0.62.', locator: 'fig-0',
  url: 'https://x/bin/g', raw: {}, retrievedAt: 'now',
};
const fakeTool = (evs: Evidence[]): Tool => ({ name: 'pmc_figures', description: '', call: async () => evs });

describe('researchFigures', () => {
  it('registers figures and emits a figure_read event with readings', async () => {
    const store = fakeStore();
    const events: TraceEvent[] = [];
    const readings: FigureReading[] = [{ evidenceId: 'PMCID:PMC1#fig-0', reading: 'r', confidence: 0.8, extractedValues: [{ label: 'HR', value: '0.62', inCaption: true, readRisk: 'low' }] }];
    const out = await researchFigures({
      pmcid: 'PMC1', question: 'q', store, specialist: 's', emit: (e) => events.push(e),
      deps: { tool: fakeTool([figEvidence]), read: async () => readings },
    });
    expect(store.items).toHaveLength(1);
    expect(events.some((e) => e.type === 'evidence_registered' && (e as any).id === 'PMCID:PMC1#fig-0')).toBe(true);
    const fr = events.find((e) => e.type === 'figure_read') as any;
    expect(fr.readings).toEqual(readings);
    expect(out).toEqual(readings);
  });

  it('degrades to [] text-only when the sidecar read throws (no figure_read event)', async () => {
    const store = fakeStore();
    const events: TraceEvent[] = [];
    const out = await researchFigures({
      pmcid: 'PMC1', question: 'q', store, specialist: 's', emit: (e) => events.push(e),
      deps: { tool: fakeTool([figEvidence]), read: async () => { throw new Error('figure sidecar HTTP 503'); } },
    });
    expect(out).toEqual([]);
    expect(events.some((e) => e.type === 'figure_read')).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(store.items).toHaveLength(1); // figures still registered; only the reading failed
  });

  it('returns [] when no figures are found', async () => {
    const store = fakeStore();
    const out = await researchFigures({
      pmcid: 'PMC1', question: 'q', store, specialist: 's', emit: () => {},
      deps: { tool: fakeTool([]), read: async () => { throw new Error('should not be called'); } },
    });
    expect(out).toEqual([]);
  });
});
