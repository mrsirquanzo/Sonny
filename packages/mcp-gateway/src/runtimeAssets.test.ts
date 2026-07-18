import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveAnalysisRuntimeAssets } from './runtimeAssets.js';

describe('analysis runtime assets', () => {
  it('resolves every image-build input, reviewed template, registry, and frozen dataset', () => {
    const assets = resolveAnalysisRuntimeAssets();

    expect(Object.values(assets).every((path) => existsSync(path))).toBe(true);
    expect(assets.dockerfile).toMatch(/Dockerfile$/);
    expect(assets.seccomp).toMatch(/seccomp\.json$/);
    expect(assets.requirements).toMatch(/requirements\.txt$/);
    expect(assets.datasetsManifest).toMatch(/datasets\.json$/);
    expect(assets.template).toMatch(/trop2_analysis\.py$/);
    expect(assets.resultsSchema).toMatch(/results_schema\.json$/);
    expect(assets.depmap).toMatch(/depmap\.crispr_gene_effect\.csv$/);
    expect(assets.gtex).toMatch(/gtex\.median_tpm\.csv$/);
    expect(assets.tumor).toMatch(/expr\.tumor\.csv$/);
  });
});
