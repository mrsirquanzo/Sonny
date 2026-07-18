import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  AnalysisResultsSchema,
  SectionSchema,
  sha256CanonicalJson,
  sha256Text,
  type AnalysisResults,
} from '@mrsirquanzo/sonny-shared';
import type { AnalysisExecutionResult } from '@mrsirquanzo/sonny-mcp-gateway';
import { assembleReferences } from './briefing.js';
import { reproducibilityGate } from './reproducibilityGate.js';
import {
  attachAnalysisToDeepResearch,
  runAnalysisSpecialist,
} from './analysisSpecialist.js';
import type { StructuredModel } from './model.js';

const goldenPath = fileURLToPath(new URL(
  '../../mcp-gateway/src/dataLake/golden/trop2_results.json',
  import.meta.url,
));
const golden = AnalysisResultsSchema.parse(JSON.parse(readFileSync(goldenPath, 'utf8')));

function execution(resultsJson: AnalysisResults = golden): AnalysisExecutionResult {
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
    artifacts: [
      { path: 'results.json', hostPath: '/tmp/trop2/results.json', mediaType: 'application/json', sizeBytes: 1, sha256: 'a'.repeat(64) },
      { path: 'trop2_analysis.png', hostPath: '/tmp/trop2/trop2_analysis.png', mediaType: 'image/png', sizeBytes: 1, sha256: 'b'.repeat(64) },
    ],
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

describe('runAnalysisSpecialist', () => {
  it('double-runs the reviewed template and maps golden typed results to grounded bounded claims', async () => {
    const executor = vi.fn(async () => execution());

    const result = await runAnalysisSpecialist({ target: 'TACSTD2', executor });

    expect(executor).toHaveBeenCalledTimes(2);
    expect(executor).toHaveBeenNthCalledWith(1, {
      templateId: 'trop2_analysis',
      params: { target: 'TACSTD2', analysisQuestion: 'trop2_profile' },
      datasetIds: ['depmap.crispr_gene_effect', 'gtex.median_tpm', 'expr.tumor'],
      timeoutMs: 120_000,
    });
    expect(executor).toHaveBeenNthCalledWith(2, expect.objectContaining({
      templateId: 'trop2_analysis',
      params: { target: 'TACSTD2', analysisQuestion: 'trop2_profile' },
    }));
    expect(result.section).toMatchObject({
      kind: 'analysis', id: 'data_analysis', title: 'Data analysis', rag: 'amber',
      figurePaths: ['/tmp/trop2/trop2_analysis.png'],
    });
    expect(result.section.claims).toHaveLength(3);
    expect(result.section.claims.map((claim) => claim.computedBinding?.resultKey)).toEqual([
      'dependency.fraction_at_or_below_locked_cutoff',
      'tumor_expression.median_by_sample_class::tumor',
      'normal_tissue.maximum_tissue_median_tpm',
    ]);
    expect(result.section.claims.every((claim) =>
      claim.citations[0] === result.evidence[0].id
      && claim.computedBinding?.computationId === result.evidence[0].computationId
      && claim.executionMode === 'live'
      && claim.replayVerification === 'verified')).toBe(true);
    expect(result.section.claims[0].text).toContain('not an ADC suitability criterion');
    expect(result.section.claims[1].text).toContain('no cross-source comparison');
    expect(result.section.claims[2].text).toContain('protein-level and clinical confirmation');
    expect(result.verifiedRun).toMatchObject({
      originReplayVerification: 'verified',
      primaryResultHash: sha256CanonicalJson(golden),
      replayResultHash: sha256CanonicalJson(golden),
    });
    expect(SectionSchema.parse(result.section)).toEqual(result.section);
  });

  it('lets the planning model choose only the schema-bounded analysis question', async () => {
    const planningModel = {
      generateStructured: vi.fn(async ({ schema }) => schema.parse({
        templateId: 'trop2_analysis', target: 'TACSTD2', analysisQuestion: 'tumor_expression',
      })),
    } as StructuredModel;
    const executor = vi.fn(async () => {
      const run = execution();
      return { ...run, params: { target: 'TACSTD2', analysisQuestion: 'tumor_expression' } };
    });

    const result = await runAnalysisSpecialist({ target: 'TROP2', planningModel, executor });

    expect(result.section.rag).toBe('amber');
    expect(planningModel.generateStructured).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenNthCalledWith(1, expect.objectContaining({
      templateId: 'trop2_analysis',
      params: { target: 'TACSTD2', analysisQuestion: 'tumor_expression' },
    }));
  });

  it('drops a fabricated asserted value through the same reproducibility gate', async () => {
    const result = await runAnalysisSpecialist({ target: 'TACSTD2', executor: async () => execution() });
    const valid = result.section.claims[0];
    const fabricated = {
      ...valid,
      computedBinding: {
        ...valid.computedBinding!,
        assertedValue: valid.computedBinding!.assertedValue + 1,
      },
    };
    const id = result.evidence[0].computationId;

    const gated = reproducibilityGate({
      claims: [fabricated],
      evidence: result.evidence,
      primaryResults: { [id]: golden },
      replayResults: { [id]: golden },
      executionMode: 'live',
    });

    expect(gated.shippable).toEqual([]);
    expect(gated.dropped[0].reason).toBe('asserted value does not match typed result');
  });

  it('returns an honest RED analysis abstention when data execution fails', async () => {
    const result = await runAnalysisSpecialist({
      target: 'TACSTD2',
      executor: async () => { throw new Error('missing dataset: gtex.median_tpm'); },
    });

    expect(result.section).toMatchObject({
      kind: 'analysis', rag: 'red', claims: [], computationIds: [], figurePaths: [],
    });
    expect(result.section.takeaway).toContain('Analysis abstained');
    expect(result.abstentionReason).toContain('missing dataset');
    expect(result.evidence).toEqual([]);
  });

  it('classifies an unavailable Docker runtime without treating analysis failures as cacheable', async () => {
    const dockerMissing = await runAnalysisSpecialist({
      target: 'TACSTD2',
      executor: async () => { throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }); },
    });
    const analysisFailure = await runAnalysisSpecialist({
      target: 'TACSTD2', executor: async () => { throw new Error('missing dataset'); },
    });

    expect(dockerMissing.failureKind).toBe('docker_unavailable');
    expect(analysisFailure.failureKind).toBe('analysis_failed');
  });

  it('attaches to the existing Briefing result shape so references retain computation provenance', async () => {
    const analysis = await runAnalysisSpecialist({ target: 'TACSTD2', executor: async () => execution() });
    const combined = attachAnalysisToDeepResearch({
      target: 'TACSTD2', sections: [], weighing: { takeaway: '', claims: [] }, evidence: [],
      kolCluster: { target: 'TACSTD2', labs: [] }, contradictions: [],
    }, analysis);

    const references = assembleReferences(combined);

    expect(combined.sections).toContain(analysis.section);
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      kind: 'computation',
      computationId: analysis.evidence[0].computationId,
      datasetInputs: analysis.evidence[0].datasetInputs,
      resultsJsonHash: sha256CanonicalJson(golden),
    });
  });
});
