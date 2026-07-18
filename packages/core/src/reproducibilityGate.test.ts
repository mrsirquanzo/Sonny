import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AnalysisResultsSchema, computationId, sha256CanonicalJson, sha256Text,
  type Claim, type ComputationEvidence,
} from '@mrsirquanzo/sonny-shared';
import { reproducibilityGate } from './reproducibilityGate.js';

const goldenPath = fileURLToPath(new URL('../../mcp-gateway/src/dataLake/golden/trop2_results.json', import.meta.url));
const golden = AnalysisResultsSchema.parse(JSON.parse(readFileSync(goldenPath, 'utf8')));
const codeBytes = 'print("reviewed template")\n';
const lineageManifest = { id: 'depmap.crispr_gene_effect', release: '24Q4' };
const dataset = {
  datasetId: 'depmap.crispr_gene_effect', logicalSourceId: 'depmap:public-24q4',
  contentSha256: '53ada942b62a3d78b1784b04599e1b64f4cbe29367224dc9ef055b77b1d43948',
  acquisitionQuery: { gene: 'TACSTD2', release: '24Q4' }, retrievedAt: '2026-07-17T20:58:39Z',
  lineageManifestHash: sha256CanonicalJson(lineageManifest), lineageManifest,
};
const manifest = {
  manifestVersion: '1.0.0' as const, templateId: golden.templateId, templateVersion: golden.templateVersion,
  datasets: [{
    datasetId: dataset.datasetId, logicalSourceId: dataset.logicalSourceId,
    contentSha256: dataset.contentSha256, acquisitionQuery: dataset.acquisitionQuery,
    retrievedAt: dataset.retrievedAt, lineageManifestHash: dataset.lineageManifestHash,
  }],
  imageDigest: `sha256:${'2'.repeat(64)}`, codeHash: sha256Text(codeBytes),
  params: { question: 'dependency', target: 'TACSTD2' }, seed: 1729,
};
const id = computationId(manifest);
const evidence: ComputationEvidence = {
  id: 'COMPUTATION:trop2', kind: 'computation', source: 'Sonny analysis', title: 'TROP2',
  snippet: 'typed output', url: '', raw: golden, retrievedAt: '2026-07-17T20:58:39Z',
  computationId: id, templateId: golden.templateId, templateVersion: golden.templateVersion,
  datasetInputs: [dataset], imageDigest: manifest.imageDigest, codeBytes, codeHash: manifest.codeHash,
  params: manifest.params, seed: manifest.seed, exitStatus: { exitCode: 0, timedOut: false, signal: null },
  resultKeys: ['dependency.median_gene_effect', 'tumor_expression.median_by_sample_class::tumor'],
  resultsJsonHash: sha256CanonicalJson(golden),
};
const claim = (over: Partial<Claim> = {}): Claim => ({
  id: 'computed-1', text: 'Median TACSTD2 gene effect was -0.0234.', citations: [evidence.id], confidence: 1,
  computedBinding: {
    computationId: id, resultKey: 'dependency.median_gene_effect',
    assertedValue: -0.0234, assertedUnit: 'Chronos gene effect',
  },
  llmVerdict: 'supported', verifierDecorrelated: true,
  ...over,
});

describe('reproducibilityGate', () => {
  it('shares the cross-package golden computation hash vector', () => {
    const sharedVector = {
      manifestVersion: '1.0.0' as const, templateId: 'trop2_analysis', templateVersion: '1.0.0',
      datasets: [{
        datasetId: 'depmap.crispr_gene_effect', logicalSourceId: 'depmap:public-24q4',
        contentSha256: '53ada942b62a3d78b1784b04599e1b64f4cbe29367224dc9ef055b77b1d43948',
        acquisitionQuery: { gene: 'TACSTD2', release: '24Q4' }, retrievedAt: '2026-07-17T20:58:39Z',
        lineageManifestHash: '1111111111111111111111111111111111111111111111111111111111111111',
      }],
      imageDigest: `sha256:${'2'.repeat(64)}`, codeHash: '3333333333333333333333333333333333333333333333333333333333333333',
      params: { question: 'dependency', target: 'TACSTD2' }, seed: 1729,
    };
    expect(computationId(sharedVector)).toBe('cff1da85cd9f4629ce5ea560e04648fb85be4d29958d4c996771a8df88609797');
  });

  it('ships a live computed claim only after a matching typed replay and keeps state dimensions separate', () => {
    const output = reproducibilityGate({
      claims: [claim()], evidence: [evidence], primaryResults: { [id]: golden },
      replayResults: { [id]: structuredClone(golden) }, executionMode: 'live',
    });
    expect(output.dropped).toEqual([]);
    expect(output.shippable[0]).toMatchObject({
      executionMode: 'live', replayVerification: 'verified', originVerification: 'none',
      llmVerdict: 'supported', verifierDecorrelated: true,
    });
  });

  it('always drops a deterministic replay mismatch beyond the declared tolerance', () => {
    const replay = structuredClone(golden);
    const result = replay.results['dependency.median_gene_effect'];
    if (result.type === 'scalar') result.value = -0.5;
    const output = reproducibilityGate({
      claims: [claim()], evidence: [evidence], primaryResults: { [id]: golden },
      replayResults: { [id]: replay }, executionMode: 'live',
    });
    expect(output.shippable).toEqual([]);
    expect(output.dropped[0].reason).toContain('replay output mismatched');
  });

  it('fails the computation-wide replay when an unbound typed output mismatches', () => {
    const replay = structuredClone(golden);
    const unrelated = replay.results['dependency.fraction_at_or_below_locked_cutoff'];
    if (unrelated.type === 'scalar') unrelated.value = 0.9;
    const output = reproducibilityGate({
      claims: [claim()], evidence: [evidence], primaryResults: { [id]: golden },
      replayResults: { [id]: replay }, executionMode: 'live',
    });
    expect(output.shippable).toEqual([]);
    expect(output.dropped[0].reason).toContain('replay output mismatched');
  });

  it('drops computation-citing claims that omit the structured binding', () => {
    const unbound = { id: 'unbound', text: 'Computed somehow.', citations: [evidence.id], confidence: 1 };
    const output = reproducibilityGate({
      claims: [unbound], evidence: [evidence], primaryResults: { [id]: golden },
      replayResults: { [id]: golden }, executionMode: 'live',
    });
    expect(output.shippable).toEqual([]);
    expect(output.dropped[0].reason).toContain('without a structured binding');
  });

  it('drops a fabricated assertion even when both computation runs reproduce perfectly', () => {
    const fabricated = claim({
      computedBinding: { ...claim().computedBinding!, assertedValue: 42 },
    });
    const output = reproducibilityGate({
      claims: [fabricated], evidence: [evidence], primaryResults: { [id]: golden },
      replayResults: { [id]: golden }, executionMode: 'live',
    });
    expect(output.shippable).toEqual([]);
    expect(output.dropped[0].reason).toContain('asserted value');
  });

  it('labels trusted cached output without pretending a local replay ran', () => {
    const output = reproducibilityGate({
      claims: [claim()], evidence: [evidence], primaryResults: { [id]: golden },
      executionMode: 'cached', originVerification: 'verified',
    });
    expect(output.shippable[0]).toMatchObject({
      executionMode: 'cached', replayVerification: 'not_run', originVerification: 'verified',
    });
  });
});
