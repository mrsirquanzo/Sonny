import { beforeEach, describe, expect, it } from 'vitest';
import type { StructuredModel } from './model.js';
import { clearQueryRewriteCache, rewriteResearchQuery } from './queryRewrite.js';

describe('rewriteResearchQuery', () => {
  beforeEach(() => clearQueryRewriteCache());

  it('keeps the original first, normalizes variants, deduplicates, and bounds output', async () => {
    const model: StructuredModel = {
      async generateStructured() {
        return { variants: [
          { target: 'CDCP1', concept: 'CDCP1 AND proteolytic cleavage' },
          { target: 'CUB domain-containing protein 1', concept: 'metastasis' },
          { target: 'CDCP1', concept: 'integrin signaling' },
        ] } as never;
      },
    };
    await expect(rewriteResearchQuery({
      target: 'CDCP1', question: 'How does cleavage drive metastasis?', concept: 'metastasis', model, variantCount: 4,
    })).resolves.toEqual([
      { target: 'CDCP1', concept: 'metastasis' },
      { target: 'CDCP1', concept: 'proteolytic cleavage' },
      { target: 'CUB domain-containing protein 1', concept: 'metastasis' },
      { target: 'CDCP1', concept: 'integrin signaling' },
    ]);
  });

  it('caches rewrites per target/question/concept', async () => {
    let calls = 0;
    const model: StructuredModel = {
      async generateStructured() { calls++; return { variants: [
        { target: 'CDCP1', concept: 'cleavage' },
        { target: 'CDCP1', concept: 'integrin' },
        { target: 'CDCP1', concept: 'FAK signaling' },
      ] } as never; },
    };
    const input = { target: 'CDCP1', question: 'q', concept: 'biology', model };
    await rewriteResearchQuery(input);
    await rewriteResearchQuery(input);
    expect(calls).toBe(1);
  });
});
