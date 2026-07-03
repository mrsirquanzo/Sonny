import { describe, it, expect } from 'vitest';
import { loadGoldens } from './goldenLoader.js';

describe('loadGoldens', () => {
  it('loads the synthetic golden and defaults groundTruthVerified to false', () => {
    const loaded = loadGoldens();
    const syn = loaded.find((l) => l.golden.name === 'synthetic-antibody');
    expect(syn).toBeDefined();
    expect(syn?.groundTruthVerified).toBe(false);
    expect(syn?.golden.patentNumber).toBe('US10123456');
    expect(syn?.sourceFile).toContain('synthetic-antibody.patent.json');
  });

  it('returns an empty list for a directory with no patent goldens', () => {
    expect(loadGoldens(new URL('./', import.meta.url).pathname)).toEqual([]);
  });
});
