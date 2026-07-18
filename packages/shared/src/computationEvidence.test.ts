import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ComputationEvidenceSchema, EvidenceSchema, ReferenceSchema, type ComputationEvidence,
} from './contracts.js';
import {
  computationId, sha256CanonicalJson, sha256Text, type CanonicalComputationManifest,
} from './computationManifest.js';
import { AnalysisResultsSchema } from './results.js';

const goldenPath = fileURLToPath(new URL('../../mcp-gateway/src/dataLake/golden/trop2_results.json', import.meta.url));
const results = AnalysisResultsSchema.parse(JSON.parse(readFileSync(goldenPath, 'utf8')));
const codeBytes = 'print("reviewed template")\n';
const lineageManifest = { id: 'depmap.crispr_gene_effect', release: '24Q4' };
const dataset = {
  datasetId: 'depmap.crispr_gene_effect', logicalSourceId: 'depmap:public-24q4',
  contentSha256: '53ada942b62a3d78b1784b04599e1b64f4cbe29367224dc9ef055b77b1d43948',
  acquisitionQuery: { gene: 'TACSTD2' }, retrievedAt: '2026-07-17T20:58:39Z',
  lineageManifestHash: sha256CanonicalJson(lineageManifest), lineageManifest,
};
const manifest: CanonicalComputationManifest = {
  manifestVersion: '1.0.0', templateId: results.templateId, templateVersion: results.templateVersion,
  datasets: [{
    datasetId: dataset.datasetId, logicalSourceId: dataset.logicalSourceId,
    contentSha256: dataset.contentSha256, acquisitionQuery: dataset.acquisitionQuery,
    retrievedAt: dataset.retrievedAt, lineageManifestHash: dataset.lineageManifestHash,
  }],
  imageDigest: `sha256:${'2'.repeat(64)}`, codeHash: sha256Text(codeBytes),
  params: { target: 'TACSTD2' }, seed: 1729,
};

export const computationEvidenceFixture: ComputationEvidence = {
  id: 'COMPUTATION:trop2-dependency', kind: 'computation', source: 'Sonny reviewed analysis',
  title: 'TACSTD2 frozen-data analysis', snippet: 'Typed reviewed-template output.', url: '',
  raw: results, retrievedAt: '2026-07-17T20:58:39Z',
  computationId: computationId(manifest), templateId: manifest.templateId,
  templateVersion: manifest.templateVersion, datasetInputs: [dataset],
  imageDigest: manifest.imageDigest, codeBytes, codeHash: manifest.codeHash,
  params: manifest.params, seed: manifest.seed,
  exitStatus: { exitCode: 0, timedOut: false, signal: null },
  resultKeys: ['dependency.median_gene_effect', 'tumor_expression.median_by_sample_class::tumor'],
  resultsJsonHash: sha256CanonicalJson(results),
};

describe('computation evidence contract', () => {
  it('keeps legacy literature evidence valid through the discriminated union', () => {
    expect(EvidenceSchema.parse({
      id: 'PMID:1', kind: 'publication', source: 'PubMed', title: 'Paper', snippet: 'Finding',
      url: 'https://example.test', raw: {}, retrievedAt: '2026-07-17T00:00:00Z',
    }).kind).toBe('publication');
  });

  it('requires and validates every content-addressed provenance and result field', () => {
    expect(ComputationEvidenceSchema.parse(computationEvidenceFixture).computationId)
      .toBe(computationEvidenceFixture.computationId);
    for (const field of [
      'computationId', 'datasetInputs', 'imageDigest', 'codeBytes', 'codeHash', 'params', 'seed',
      'exitStatus', 'resultKeys', 'resultsJsonHash',
    ]) {
      const incomplete = { ...computationEvidenceFixture, [field]: undefined };
      expect(() => EvidenceSchema.parse(incomplete), field).toThrow();
    }
  });

  it('rejects altered code, results, lineage, or computation identity', () => {
    expect(() => EvidenceSchema.parse({ ...computationEvidenceFixture, codeBytes: 'fabricated' })).toThrow();
    expect(() => EvidenceSchema.parse({ ...computationEvidenceFixture, resultsJsonHash: 'f'.repeat(64) })).toThrow();
    expect(() => EvidenceSchema.parse({ ...computationEvidenceFixture, computationId: 'f'.repeat(64) })).toThrow();
    expect(() => EvidenceSchema.parse({
      ...computationEvidenceFixture,
      datasetInputs: [{ ...dataset, lineageManifest: { id: 'altered' } }],
    })).toThrow();
  });

  it('preserves computation provenance in the reference contract', () => {
    const { snippet: _snippet, raw: _raw, ...reference } = computationEvidenceFixture;
    expect(ReferenceSchema.parse(reference)).toMatchObject({
      kind: 'computation', computationId: computationEvidenceFixture.computationId,
      resultsJsonHash: computationEvidenceFixture.resultsJsonHash,
    });
  });
});
