import { describe, expect, it, vi } from 'vitest';
import type { AnalysisSpecialistResult } from '@mrsirquanzo/sonny-core';
import { renderAnalysisSection, runAnalyze } from './analyze.js';

const computationId = 'a'.repeat(64);
const analysisResult = {
  section: {
    kind: 'analysis',
    id: 'data_analysis',
    title: 'Data analysis',
    takeaway: 'Three bounded TACSTD2 signals reproduced.',
    claims: [{
      id: 'analysis-dependency',
      text: 'Dependency is descriptive biology context.',
      citations: [`COMPUTATION:${computationId}`],
      confidence: 1,
      computedBinding: {
        computationId,
        resultKey: 'dependency.fraction_at_or_below_locked_cutoff',
        assertedValue: 0.000845,
        assertedUnit: 'fraction of observed models',
      },
      executionMode: 'live', replayVerification: 'verified', originVerification: 'none',
    }],
    sources: [`COMPUTATION:${computationId}`],
    rag: 'amber',
    computationIds: [computationId],
    figurePaths: ['/tmp/analysis-runs/abc/trop2_analysis.png'],
  },
  evidence: [{
    id: `COMPUTATION:${computationId}`,
    kind: 'computation',
    computationId,
    datasetInputs: [
      { datasetId: 'depmap.crispr_gene_effect', contentSha256: 'b'.repeat(64) },
      { datasetId: 'gtex.median_tpm', contentSha256: 'c'.repeat(64) },
      { datasetId: 'expr.tumor', contentSha256: 'd'.repeat(64) },
    ],
  }],
  dropped: [],
} as unknown as AnalysisSpecialistResult;

describe('analysis CLI', () => {
  it('renders the analysis summary, figure path, computation provenance, hashes, and verification state', () => {
    const rendered = renderAnalysisSection(analysisResult);

    expect(rendered).toContain('[AMBER] Data analysis');
    expect(rendered).toContain('Dependency is descriptive biology context.');
    expect(rendered).toContain('/tmp/analysis-runs/abc/trop2_analysis.png');
    expect(rendered).toContain(`computationId: ${computationId}`);
    expect(rendered).toContain(`depmap.crispr_gene_effect: ${'b'.repeat(64)}`);
    expect(rendered).toContain('executionMode: live');
    expect(rendered).toContain('replayVerification: verified');
    expect(rendered).toContain('originVerification: none');
  });

  it('runs the specialist for the requested target and writes its rendered section', async () => {
    const analyze = vi.fn(async () => analysisResult);
    const write = vi.fn();

    await runAnalyze('TACSTD2', { analyze, write });

    expect(analyze).toHaveBeenCalledWith({ target: 'TACSTD2' });
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0]).toContain('[AMBER] Data analysis');
  });
});
