import { describe, expect, it } from 'vitest';
import { canonicalJson, computationId, sha256Text, type CanonicalComputationManifest } from './computationManifest.js';

export const GOLDEN_MANIFEST: CanonicalComputationManifest = {
  manifestVersion: '1.0.0',
  templateId: 'trop2_analysis',
  templateVersion: '1.0.0',
  datasets: [{
    datasetId: 'depmap.crispr_gene_effect',
    logicalSourceId: 'depmap:public-24q4',
    contentSha256: '53ada942b62a3d78b1784b04599e1b64f4cbe29367224dc9ef055b77b1d43948',
    acquisitionQuery: { gene: 'TACSTD2', release: '24Q4' },
    retrievedAt: '2026-07-17T20:58:39Z',
    lineageManifestHash: '1111111111111111111111111111111111111111111111111111111111111111',
  }],
  imageDigest: `sha256:${'2'.repeat(64)}`,
  codeHash: '3333333333333333333333333333333333333333333333333333333333333333',
  params: { question: 'dependency', target: 'TACSTD2' },
  seed: 1729,
};

describe('computationId JCS contract', () => {
  it('implements the standard SHA-256 abc vector', () => {
    expect(sha256Text('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('canonicalizes object keys recursively without changing array order', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: [3, { b: true, a: null }] } }))
      .toBe('{"a":{"x":[3,{"a":null,"b":true}],"y":2},"z":1}');
  });

  it('matches the versioned golden hash vector regardless of insertion order', () => {
    const reordered = { ...GOLDEN_MANIFEST, params: { target: 'TACSTD2', question: 'dependency' } };
    const expected = 'cff1da85cd9f4629ce5ea560e04648fb85be4d29958d4c996771a8df88609797';
    expect(computationId(GOLDEN_MANIFEST)).toBe(expected);
    expect(computationId(reordered)).toBe(expected);
  });

  it('rejects fields outside the enumerated manifest contract', () => {
    expect(() => computationId({ ...GOLDEN_MANIFEST, unexpected: true } as never)).toThrow();
  });

  it('normalizes dataset ordering as part of the canonical manifest', () => {
    const second = {
      ...GOLDEN_MANIFEST.datasets[0], datasetId: 'gtex.median_tpm', logicalSourceId: 'gtex:v8',
      contentSha256: '4'.repeat(64),
    };
    expect(computationId({ ...GOLDEN_MANIFEST, datasets: [GOLDEN_MANIFEST.datasets[0], second] }))
      .toBe(computationId({ ...GOLDEN_MANIFEST, datasets: [second, GOLDEN_MANIFEST.datasets[0]] }));
  });
});
