import { describe, it, expect } from 'vitest';
import type { Section, TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { StructuredModel } from '../model.js';
import { EvidenceStore } from '../evidenceStore.js';
import { assessDevelopability } from './developability.js';

function storeWith(id: string): EvidenceStore {
  const store = new EvidenceStore();
  store.register({ id, kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' });
  return store;
}

const section: Section = {
  kind: 'research', id: 'modality_developability', title: 'Modality & Developability', takeaway: 't',
  claims: [{ id: 'c1', text: 'High ADA incidence reported.', citations: ['PMID:9'], confidence: 0.8 }],
  sources: ['PMID:9'], rag: 'red',
};

describe('assessDevelopability', () => {
  it('keeps only risks grounded in a real store evidence id and emits the trace', async () => {
    const model: StructuredModel = {
      async generateStructured() {
        return { risks: [
          { evidenceId: 'PMID:9', category: 'immunogenicity', severity: 'severe', explanation: 'High ADA incidence.' },
          { evidenceId: 'PMID:404', category: 'half_life', severity: 'significant', explanation: 'Not in store.' },
        ] } as never;
      },
    };
    const events: TraceEvent[] = [];
    const risks = await assessDevelopability({ section, store: storeWith('PMID:9'), model, emit: (e) => events.push(e) });
    expect(risks.map((r) => r.evidenceId)).toEqual(['PMID:9']);           // PMID:404 dropped - no token, no ship
    expect(risks[0].severity).toBe('severe');
    expect(events.some((e) => e.type === 'developability_assessment')).toBe(true);
  });

  it('returns an empty list when the section has no claims', async () => {
    const model: StructuredModel = { async generateStructured() { return { risks: [] } as never; } };
    const risks = await assessDevelopability({ section: { ...section, claims: [] }, store: storeWith('PMID:9'), model, emit: () => {} });
    expect(risks).toEqual([]);
  });

  // Q6 is a lens-reading axis. Curated cards no longer editorialize risk into
  // their own text, so if the lens does not reach this prompt nothing tells the
  // reviewer which bare facts constitute a liability - which is exactly how
  // developability_catch fell from 0.500 to 0.000 on CDCP1.
  it('puts every resolved Q6 lens factor into the system prompt', async () => {
    let system = '';
    const model: StructuredModel = {
      async generateStructured(request) { system = request.system; return { risks: [] } as never; },
    };
    const q6Lens = ['on-target, off-tumour toxicity', 'normal-tissue antigen expression'];
    await assessDevelopability({ section, store: storeWith('PMID:9'), model, emit: () => {}, q6Lens });
    for (const factor of q6Lens) expect(system).toContain(factor);
  });

  it('instructs the reviewer to interpret bare facts rather than wait for the word "risk"', async () => {
    let system = '';
    const model: StructuredModel = {
      async generateStructured(request) { system = request.system; return { risks: [] } as never; },
    };
    await assessDevelopability({ section, store: storeWith('PMID:9'), model, emit: () => {} });
    expect(system).toMatch(/state facts without interpreting them/i);
    // Grounding discipline must survive the added latitude.
    expect(system).toMatch(/must rest on a stated fact/i);
  });

  it('omits the lens clause entirely when no lens is resolved', async () => {
    let system = '';
    const model: StructuredModel = {
      async generateStructured(request) { system = request.system; return { risks: [] } as never; },
    };
    await assessDevelopability({ section, store: storeWith('PMID:9'), model, emit: () => {}, q6Lens: [] });
    expect(system).not.toContain('modality-specific liability factors');
  });
});
