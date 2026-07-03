import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('throws an error containing the file name and missing field when a golden is malformed', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'sonny-golden-test-'));
    const fileName = 'malformed.patent.json';
    const filePath = join(tmpDir, fileName);
    try {
      // Write a golden missing the required "patentNumber" field.
      writeFileSync(filePath, JSON.stringify({
        name: 'malformed-test',
        declaredSequenceCount: 1,
        knownSequences: [],
        expectedConstructs: [],
      }));
      expect(() => loadGoldens(tmpDir)).toThrow(/malformed\.patent\.json/);
      expect(() => loadGoldens(tmpDir)).toThrow(/patentNumber/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
