import { describe, it, expect } from 'vitest';
import type { StructuredModel } from './model.js';
import { planResearchQuestions, extractClaims, type ThreadBrief } from './researcher.js';

const brief: ThreadBrief = {
  id: 'target_biology', title: 'Target Biology',
  objective: 'Characterize the target biology and MOA.',
  promptHint: 'Describe structure, MOA, expression.',
};

function modelReturning(value: unknown): StructuredModel {
  return { async generateStructured() { return value as never; } };
}

describe('planResearchQuestions', () => {
  it('returns the planned questions and includes the target in the prompt', async () => {
    let prompt = '';
    const model: StructuredModel = {
      async generateStructured(opts) { prompt = opts.prompt; return { questions: ['What is the MOA of CDCP1?'] } as never; },
    };
    const qs = await planResearchQuestions(brief, 'CDCP1', model);
    expect(qs).toEqual(['What is the MOA of CDCP1?']);
    expect(prompt).toContain('CDCP1');
    expect(prompt).toContain('Target Biology');
  });
});

describe('extractClaims', () => {
  it('returns claims as drafted by the model', async () => {
    const model = modelReturning({ claims: [
      { id: 'c1', text: 'CDCP1 drives EMT.', citations: ['PMCID:PMC1#sec-1'], confidence: 0.8 },
    ] });
    const claims = await extractClaims('What is the MOA?', '[PMCID:PMC1#sec-1] (Results) ...', model);
    expect(claims).toHaveLength(1);
    expect(claims[0].citations).toEqual(['PMCID:PMC1#sec-1']);
  });
});
