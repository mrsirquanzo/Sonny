import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AnalysisResultsSchema, resolveResultBinding } from './results.js';

const goldenPath = fileURLToPath(new URL('../../mcp-gateway/src/dataLake/golden/trop2_results.json', import.meta.url));
const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as unknown;

describe('AnalysisResultsSchema', () => {
  it('validates the untouched Slice 1 TROP2 golden results file', () => {
    const parsed = AnalysisResultsSchema.parse(golden);
    expect(parsed.schemaVersion).toBe('1.0.0');
    expect(Object.keys(parsed.results)).toHaveLength(9);
  });

  it('requires every typed scalar field and enforces explicit nullability', () => {
    const parsed = AnalysisResultsSchema.parse(golden);
    const scalar = parsed.results['dependency.median_gene_effect'];
    expect(scalar).toMatchObject({
      type: 'scalar', value: -0.0234, unit: 'Chronos gene effect', threshold: null,
      nullable: false, sampleN: 1183,
    });
    expect(() => AnalysisResultsSchema.parse({
      ...parsed,
      results: { x: { ...scalar, tolerance: undefined } },
    })).toThrow();
  });

  it('resolves grouped points through an unambiguous structured key', () => {
    const parsed = AnalysisResultsSchema.parse(golden);
    expect(resolveResultBinding(parsed, 'tumor_expression.median_by_sample_class::tumor'))
      .toMatchObject({ value: 5924.585, unit: 'RSEM' });
    expect(resolveResultBinding(parsed, 'tumor_expression.median_by_sample_class')).toBeUndefined();
  });
});
