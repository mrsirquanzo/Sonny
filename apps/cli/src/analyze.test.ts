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

    expect(rendered).toContain('=== [AMBER] Data analysis ===');
    expect(rendered).toContain('Claims (bounded):');
    expect(rendered).toContain('Dependency is descriptive biology context.');
    expect(rendered).toContain('/tmp/analysis-runs/abc/trop2_analysis.png');
    expect(rendered).toContain(`computationId: ${computationId}`);
    expect(rendered).toContain(`depmap.crispr_gene_effect: ${'b'.repeat(64)}`);
    expect(rendered).toContain('Verification: LIVE / REPLAY VERIFIED');
    expect(rendered).toContain('execution mode : live');
    expect(rendered).toContain('replay         : verified');
    expect(rendered).toContain('origin         : none');
  });

  it('runs the specialist for the requested target and writes its rendered section', async () => {
    const analyze = vi.fn(async () => analysisResult);
    const write = vi.fn();

    await runAnalyze('TACSTD2', { analyze, write });

    expect(analyze).toHaveBeenCalledWith({ target: 'TACSTD2' });
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0]).toContain('=== [AMBER] Data analysis ===');
  });

  it('uses a verified signed cache only when Docker is unavailable and labels it cached', async () => {
    const unavailable = {
      ...analysisResult,
      section: { ...analysisResult.section, rag: 'red', claims: [], computationIds: [], figurePaths: [] },
      evidence: [],
      abstentionReason: 'spawn docker ENOENT',
      failureKind: 'docker_unavailable',
    } as unknown as AnalysisSpecialistResult;
    const cached = {
      ...analysisResult,
      section: {
        ...analysisResult.section,
        claims: analysisResult.section.claims.map((claim) => ({
          ...claim, executionMode: 'cached', replayVerification: 'not_run', originVerification: 'verified',
        })),
      },
    } as unknown as AnalysisSpecialistResult;
    const loadCached = vi.fn(async () => cached);
    const write = vi.fn();

    const result = await runAnalyze('TACSTD2', {
      analyze: async () => unavailable,
      loadCached,
      write,
    });

    expect(result).toBe(cached);
    expect(loadCached).toHaveBeenCalledWith('TACSTD2');
    expect(write.mock.calls[0][0]).toContain('Verification: CACHED / ORIGIN VERIFIED');
    expect(write.mock.calls[0][0]).toContain('replay         : not_run');
  });

  it('does not use cached output for a scientific/data failure', async () => {
    const failed = { ...analysisResult, failureKind: 'analysis_failed' } as AnalysisSpecialistResult;
    const loadCached = vi.fn(async () => analysisResult);

    await runAnalyze('TACSTD2', { analyze: async () => failed, loadCached, write: vi.fn() });

    expect(loadCached).not.toHaveBeenCalled();
  });
});
