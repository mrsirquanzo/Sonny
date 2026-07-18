import { createHash } from 'node:crypto';
import {
  cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AnalysisResultsSchema, sha256CanonicalJson, sha256Text, type AnalysisResults,
} from '@mrsirquanzo/sonny-shared';
import type { AnalysisExecutionResult } from '@mrsirquanzo/sonny-mcp-gateway';
import { runAnalysisSpecialist } from './analysisSpecialist.js';
import {
  CachedAnalysisBundleError,
  createSignedCachedAnalysisBundle,
  loadSignedCachedAnalysisBundle,
} from './cachedAnalysis.js';

const goldenResultsPath = fileURLToPath(new URL(
  '../../mcp-gateway/src/dataLake/golden/trop2_results.json', import.meta.url,
));
const goldenPngPath = fileURLToPath(new URL(
  '../../mcp-gateway/src/dataLake/golden/trop2_analysis.png', import.meta.url,
));
const privateKeyPath = fileURLToPath(new URL('./fixtures/dev-release-private-key.pem', import.meta.url));
const golden = AnalysisResultsSchema.parse(JSON.parse(readFileSync(goldenResultsPath, 'utf8')));

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function execution(root: string, resultsJson: AnalysisResults = golden): AnalysisExecutionResult {
  const resultsPath = join(root, 'results.json');
  const pngPath = join(root, 'trop2_analysis.png');
  writeFileSync(resultsPath, `${JSON.stringify(resultsJson)}\n`);
  cpSync(goldenPngPath, pngPath);
  const codeBytes = '# reviewed TACSTD2 template\n';
  const datasetHashes = [
    ['depmap.crispr_gene_effect', 'depmap:public-release'],
    ['gtex.median_tpm', 'gtex:v8'],
    ['expr.tumor', 'cbioportal:brca_tcga_pan_can_atlas_2018'],
  ].map(([datasetId, logicalSourceId], index) => {
    const lineageManifest = { datasetId, fixture: true, index };
    return {
      datasetId,
      logicalSourceId,
      contentSha256: String(index + 1).repeat(64),
      acquisitionQuery: { fixture: true },
      retrievedAt: '2026-07-17T20:58:39Z',
      lineageManifestHash: sha256CanonicalJson(lineageManifest),
      lineageManifest,
    };
  });
  return {
    resultsJson,
    artifacts: [resultsPath, pngPath].map((hostPath) => {
      const bytes = readFileSync(hostPath);
      return {
        path: hostPath.endsWith('.png') ? 'trop2_analysis.png' : 'results.json',
        hostPath,
        mediaType: hostPath.endsWith('.png') ? 'image/png' as const : 'application/json' as const,
        sizeBytes: bytes.byteLength,
        sha256: sha256(bytes),
      };
    }),
    exitCode: 0,
    timedOut: false,
    imageDigest: `sha256:${'c'.repeat(64)}`,
    codeBytes,
    codeHash: sha256Text(codeBytes),
    datasetHashes,
    params: { target: 'TACSTD2', analysisQuestion: 'trop2_profile' },
    seed: 1729,
  };
}

const temporaryRoots: string[] = [];
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sonny-cached-analysis-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('signed cached analysis bundles', () => {
  it('round-trips a reproducibility-verified golden run and reconstructs cached trust states', async () => {
    const root = temporaryRoot();
    const run = execution(root);
    const live = await runAnalysisSpecialist({ target: 'TACSTD2', executor: async () => run });
    const bundlePath = join(root, 'TACSTD2.cached-run.json');

    createSignedCachedAnalysisBundle({
      result: live,
      outputPath: bundlePath,
      privateKeyPem: readFileSync(privateKeyPath, 'utf8'),
    });
    const cached = loadSignedCachedAnalysisBundle({
      bundlePath,
      artifactRoot: join(root, 'materialized'),
    });

    expect(live.verifiedRun).toEqual({
      originReplayVerification: 'verified',
      primaryResultHash: sha256CanonicalJson(golden),
      replayResultHash: sha256CanonicalJson(golden),
      artifacts: run.artifacts,
    });
    expect(cached.section.claims).toHaveLength(3);
    expect(cached.section.claims.every((claim) =>
      claim.executionMode === 'cached'
      && claim.originVerification === 'verified'
      && claim.replayVerification === 'not_run')).toBe(true);
    expect(cached.section.figurePaths[0]).toMatch(/materialized.*trop2_analysis\.png$/);
    expect(readFileSync(cached.section.figurePaths[0])).toEqual(readFileSync(goldenPngPath));
    expect(cached.verifiedRun).toBeUndefined();
  });

  it('rejects a tampered signed bundle', async () => {
    const root = temporaryRoot();
    const run = execution(root);
    const live = await runAnalysisSpecialist({ target: 'TACSTD2', executor: async () => run });
    const bundlePath = join(root, 'TACSTD2.cached-run.json');
    createSignedCachedAnalysisBundle({
      result: live, outputPath: bundlePath, privateKeyPem: readFileSync(privateKeyPath, 'utf8'),
    });

    const tampered = JSON.parse(readFileSync(bundlePath, 'utf8')) as {
      payload: { artifacts: Array<{ contentBase64: string }> };
    };
    tampered.payload.artifacts[0].contentBase64 = Buffer.from('tampered').toString('base64');
    writeFileSync(bundlePath, JSON.stringify(tampered));

    expect(() => loadSignedCachedAnalysisBundle({ bundlePath, artifactRoot: join(root, 'out') }))
      .toThrow(CachedAnalysisBundleError);
  });

  it('refuses to sign anything except a successful verified live double-run', () => {
    const root = temporaryRoot();
    expect(() => createSignedCachedAnalysisBundle({
      result: {
        section: {
          kind: 'analysis', id: 'data_analysis', title: 'Data analysis', takeaway: 'abstained',
          claims: [], sources: [], rag: 'red', computationIds: [], figurePaths: [],
        },
        evidence: [], dropped: [], abstentionReason: 'Docker unavailable',
      },
      outputPath: join(root, 'bad.json'),
      privateKeyPem: readFileSync(privateKeyPath, 'utf8'),
    })).toThrow(/verified live double-run/i);
  });

  it('enforces the cached-history policy and expected target binding', async () => {
    const root = temporaryRoot();
    const run = execution(root);
    const live = await runAnalysisSpecialist({ target: 'TACSTD2', executor: async () => run });
    const bundlePath = join(root, 'TACSTD2.cached-run.json');
    createSignedCachedAnalysisBundle({
      result: live, outputPath: bundlePath, privateKeyPem: readFileSync(privateKeyPath, 'utf8'),
    });

    expect(() => loadSignedCachedAnalysisBundle({
      bundlePath, artifactRoot: join(root, 'out-policy'), allowHistoricallyVerifiedCachedClaims: false,
    })).toThrow(/disabled by policy/i);
    expect(() => loadSignedCachedAnalysisBundle({
      bundlePath, artifactRoot: join(root, 'out-target'), expectedTarget: 'CDCP1',
    })).toThrow(/does not match requested target/i);
  });
});
