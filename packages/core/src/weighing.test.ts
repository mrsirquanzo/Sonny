import { describe, it, expect } from 'vitest';
import type { Section } from '@mrsirquanzo/sonny-shared';
import type { StructuredModel } from './model.js';
import { EvidenceStore } from './evidenceStore.js';
import { weighAcrossThreads } from './weighing.js';

const sections: Section[] = [
  { id: 'disease_indications', title: 'Disease & Indications', takeaway: 'Weak genetics.', claims: [
    { id: 'c1', text: 'Genetic association is 0.11.', citations: ['ENSG1'], confidence: 0.7 },
  ], sources: ['ENSG1'], rag: 'amber' },
  { id: 'moa_pathway', title: 'MOA & Pathway', takeaway: 'Strong mechanism.', claims: [
    { id: 'c2', text: 'Drives EMT.', citations: ['PMID:1'], confidence: 0.8 },
  ], sources: ['PMID:1'], rag: 'green' },
];

describe('weighAcrossThreads', () => {
  it('produces grounded, verified reconciliation claims and a takeaway', async () => {
    const store = new EvidenceStore();
    store.register({ id: 'ENSG1', kind: 'target', source: 'OT', title: 'T', snippet: 's', url: 'u', raw: {}, retrievedAt: 'now' });
    store.register({ id: 'PMID:1', kind: 'publication', source: 'PMC', title: 'P', snippet: 's', url: 'u', raw: {}, retrievedAt: 'now' });
    const leadModel = { async generateStructured() {
      return { takeaway: 'Genetics weak but mechanism strong.', claims: [
        { id: 'w1', text: 'The weak genetic association conflicts with strong mechanistic evidence; mechanism leans more credible.', citations: ['ENSG1', 'PMID:1'], confidence: 0.7 },
      ] } as never;
    } };
    const verifierModel = { async generateStructured() { return { claimId: 'x', status: 'supported', rationale: 'ok' } as never; } };
    const out = await weighAcrossThreads({ sections, store, leadModel, verifierModel, emit: () => {} });
    expect(out.takeaway).toContain('mechanism');
    expect(out.claims.map((c) => c.id)).toEqual(['w1']);
  });
});

const gradeSections: Section[] = [{
  id: 'a', title: 'A', takeaway: 't', rag: 'amber', sources: ['PMID:1'],
  claims: [
    { id: 'c1', text: 'Strong RCT finding.', citations: ['PMID:1'], confidence: 0.9 },
    { id: 'c2', text: 'Abstract-only finding.', citations: ['PMID:9'], confidence: 0.5 },
  ],
  critiques: [{ evidenceId: 'PMID:1', studyDesign: 'randomized_controlled', redFlags: [], evidenceLevel: 'high' }],
}];

describe('weighAcrossThreads grade annotation', () => {
  it('annotates claim lines with the cited evidence GRADE and instructs weighing it', async () => {
    let prompt = ''; let system = '';
    const model: StructuredModel = {
      async generateStructured(opts) { prompt = opts.prompt; system = opts.system; return { takeaway: 'tk', claims: [] } as never; },
    };
    const store = new EvidenceStore();
    await weighAcrossThreads({ sections: gradeSections, store, leadModel: model, verifierModel: model, emit: () => {} });
    expect(prompt).toContain('(GRADE: high)');       // c1 cites a graded RCT
    expect(prompt).toContain('(GRADE: ungraded)');    // c2 cites an un-audited abstract
    expect(system.toLowerCase()).toContain('grade');  // instruction to weigh by tier
  });
});
