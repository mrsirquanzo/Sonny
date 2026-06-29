import { describe, it, expect } from 'vitest';
import type { Section, Claim, Evidence } from '@sonny/shared';
import type { StructuredModel } from './model.js';
import { synthesizeRecommendation } from './synthesize.js';

const sections: Section[] = [
  { id: 'moa_pathway', title: 'MOA & Pathway', takeaway: 'Strong mechanism.',
    claims: [{ id: 'c1', text: 'Drives EMT.', citations: ['PMID:1'], confidence: 0.8 }], sources: ['PMID:1'], rag: 'green' },
];
const weighing = { takeaway: 'Mechanism strong, genetics weak.', claims: [
  { id: 'w1', text: 'Mechanism outweighs weak genetics.', citations: ['PMID:1'], confidence: 0.7 } as Claim,
] };
const evidence: Evidence[] = [
  { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'P', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' },
];

describe('synthesizeRecommendation', () => {
  it('produces a recommendation from verified claims and drops phantom citations', async () => {
    let prompt = '';
    const model: StructuredModel = {
      async generateStructured(opts) {
        prompt = opts.prompt;
        return {
          verdict: 'watch', thesis: 'Mechanistically interesting, under-validated.',
          bull: [{ point: 'Strong mechanism.', citations: ['PMID:1', 'PMID:999'] }], // PMID:999 is phantom
          bear: [{ point: 'Weak genetics.', citations: ['PMID:1'] }],
          conditions: ['A positive Phase 1 readout moves to GO.'],
          executiveRead: 'CDCP1 is mechanistically compelling but genetically thin.',
        } as never;
      },
    };
    const { recommendation, executiveRead } = await synthesizeRecommendation({ sections, weighing, evidence, model });
    expect(recommendation.verdict).toBe('watch');
    // phantom citation dropped, real one kept
    expect(recommendation.bull[0].citations).toEqual(['PMID:1']);
    expect(executiveRead).toContain('mechanistically');
    // synthesizer saw the verified claims, not raw evidence text
    expect(prompt).toContain('Drives EMT.');
    expect(prompt).toContain('Mechanism outweighs weak genetics.');
  });
});
