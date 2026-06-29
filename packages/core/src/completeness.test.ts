import { describe, it, expect } from 'vitest';
import type { Section } from '@sonny/shared';
import type { StructuredModel } from './model.js';
import { assessCompleteness } from './completeness.js';

const sections: Section[] = [
  { id: 'target_biology', title: 'Target Biology', takeaway: 'Solid.', claims: [], sources: ['ENSG1', 'PMID:1'], rag: 'green' },
  { id: 'clinical_landscape', title: 'Clinical Landscape', takeaway: 'Thin.', claims: [], sources: [], rag: 'red' },
];

describe('assessCompleteness', () => {
  it('returns the critic verdict and includes the section summaries in the prompt', async () => {
    let prompt = '';
    const model: StructuredModel = {
      async generateStructured(opts) {
        prompt = opts.prompt;
        return { complete: false, gaps: [
          { specialistId: 'clinical_landscape', question: 'What trials exist?', searchQuery: 'CDCP1 clinical trial', reason: 'section is red' },
        ] } as never;
      },
    };
    const out = await assessCompleteness(sections, model);
    expect(out.complete).toBe(false);
    expect(out.gaps[0].specialistId).toBe('clinical_landscape');
    expect(prompt).toContain('Clinical Landscape');
    expect(prompt).toContain('red');
  });
});
