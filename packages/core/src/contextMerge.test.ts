import { beforeEach, describe, expect, it, vi } from 'vitest';

const observed = vi.hoisted(() => ({
  contexts: [] as Array<{ indication?: string; modality?: string } | undefined>,
}));

vi.mock('./produceResearchSection.js', () => ({
  produceResearchSection: vi.fn(async (opts: {
    brief: { id: string; title: string };
    context?: { indication?: string; modality?: string };
  }) => {
    observed.contexts.push(opts.context);
    return {
      kind: 'research',
      id: opts.brief.id,
      title: opts.brief.title,
      takeaway: '',
      claims: [],
      sources: [],
      rag: 'red',
    };
  }),
}));
vi.mock('./orientation.js', () => ({
  orientWithReview: vi.fn(async () => undefined),
}));
vi.mock('./completeness.js', () => ({
  assessCompleteness: vi.fn(async () => ({ complete: true, gaps: [] })),
  fillGap: vi.fn(),
  mergeGapClaims: vi.fn(),
}));
vi.mock('./weighing.js', () => ({
  weighAcrossThreads: vi.fn(async () => ({ takeaway: '', claims: [] })),
}));
vi.mock('./critique/consistency.js', () => ({
  detectContradictions: vi.fn(async () => []),
}));

import { runDeepResearch } from './runDeepResearch.js';

describe('per-field research context merge', () => {
  beforeEach(() => {
    observed.contexts.length = 0;
  });

  it('keeps the parsed indication when the caller supplies only modality', async () => {
    const leadModel = {
      async generateStructured(request: { system: string }) {
        if (request.system.includes('extract its scope')) {
          return { target: 'KRAS', indication: 'NSCLC' } as never;
        }
        throw new Error(`unexpected lead-model call: ${request.system}`);
      },
    };
    await runDeepResearch({
      target: 'assess KRAS in NSCLC',
      roster: [{ id: 'target_biology', title: 'Target biology', objective: 'Validate', promptHint: 'Bounded' }],
      literatureTools: [],
      structuredTools: [],
      specialistModel: leadModel,
      verifierModel: leadModel,
      leadModel,
      emit: () => {},
      budget: { maxRounds: 1 },
      context: { modality: 'ADC' },
    });

    expect(observed.contexts).toEqual([
      expect.objectContaining({ indication: 'NSCLC', modality: 'ADC' }),
    ]);
  });
});
