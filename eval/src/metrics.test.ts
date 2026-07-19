import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  groundingIntegrity, retrievalRecall, verdictInBand, verdictStability,
  makeJudge, figureGrounding, computationGrounding, type RunArtifacts, type StructuredModelLike,
} from './metrics.js';
import { GoldenTarget } from './goldenSet.js';
import {
  AnalysisResultsSchema, computationId, sha256CanonicalJson, sha256Text,
  type ComputationEvidence,
} from '@mrsirquanzo/sonny-shared';
import { reproducibilityGate } from '@mrsirquanzo/sonny-core';

const target = GoldenTarget.parse({
  target: 'CDCP1', label: 'watch', allowedVerdicts: ['watch', 'go'], rationale: 'r',
  seminalPmids: ['23208492'], curator: 'c', curatedAt: '2026-07-02',
});

function artifacts(over: Partial<RunArtifacts> = {}): RunArtifacts {
  return {
    briefing: {
      verdict: 'watch',
      sections: [{ id: 's', claims: [{ id: 'c1', text: 'x', citations: ['PMID:23208492'] }] }],
    },
    evidenceById: new Map([['PMID:23208492', { id: 'PMID:23208492', passage: 'CDCP1 is cleaved.' }]]),
    elapsedMs: 100,
    ...over,
  } as RunArtifacts;
}

describe('deterministic metrics', () => {
  it('groundingIntegrity is 1.0 when every claim citation resolves', () => {
    expect(groundingIntegrity(artifacts()).score).toBe(1);
  });

  it('groundingIntegrity flags an unresolvable citation', () => {
    const a = artifacts({
      briefing: { verdict: 'watch', sections: [{ id: 's', claims: [{ id: 'c1', text: 'x', citations: ['PMID:999'] }] }] } as any,
    });
    const m = groundingIntegrity(a);
    expect(m.score).toBe(0);
    expect(m.pass).toBe(false);
  });

  it('retrievalRecall measures gold PMIDs pulled into the store', () => {
    expect(retrievalRecall(artifacts(), target).score).toBe(1);
    const empty = artifacts({ evidenceById: new Map() });
    expect(retrievalRecall(empty, target).score).toBe(0);
  });

  it('verdictInBand passes inside the band and fails outside', () => {
    expect(verdictInBand(artifacts(), target).pass).toBe(true);
    expect(verdictInBand(artifacts({ briefing: { verdict: 'no-go', sections: [] } as any }), target).pass).toBe(false);
  });

  it('verdictStability reports flip rate across repeats', () => {
    expect(verdictStability(['watch', 'watch', 'watch']).score).toBe(1);
    expect(verdictStability(['watch', 'go', 'watch']).pass).toBe(false);
  });
});

function figArtifacts(claims: { text: string; citations: string[] }[], figureReadings: any[]): RunArtifacts {
  return {
    briefing: { verdict: 'watch', sections: [{ id: 's', claims: claims.map((c, i) => ({ id: `c${i}`, ...c })) }] },
    evidenceById: new Map(), elapsedMs: 0, figureReadings,
  } as unknown as RunArtifacts;
}

const lowReading = { evidenceId: 'PMCID:P#fig-0', reading: 'r', confidence: 0.8, extractedValues: [{ label: 'HR', value: '0.62', inCaption: true, readRisk: 'low' }] };
const highReading = { evidenceId: 'PMCID:P#fig-1', reading: 'r', confidence: 0.8, extractedValues: [{ label: 'HR', value: '0.41', inCaption: false, readRisk: 'high' }] };

describe('figureGrounding', () => {
  it('is not gated (pass) when n < 3, reporting the denominator', () => {
    const a = figArtifacts([{ text: 'HR 0.62', citations: ['PMCID:P#fig-0'] }], [lowReading]);
    const m = figureGrounding(a);
    expect((m.detail as any).n).toBe(1);
    expect(m.pass).toBe(true);
  });

  it('scores fraction caption-anchored and fails below the floor when gated (n>=3)', () => {
    const a = figArtifacts([
      { text: 'a', citations: ['PMCID:P#fig-1'] },
      { text: 'b', citations: ['PMCID:P#fig-1'] },
      { text: 'c', citations: ['PMCID:P#fig-1'] },
      { text: 'd', citations: ['PMCID:P#fig-0'] },
    ], [lowReading, highReading]);
    const m = figureGrounding(a);
    expect((m.detail as any).n).toBe(4);
    expect(m.score).toBeCloseTo(0.25, 5); // only the fig-0 claim is anchored
    expect(m.pass).toBe(false);           // 0.25 < 0.5 floor
  });

  it('ignores non-figure claims (returns 1.0 when no figure claims)', () => {
    const a = figArtifacts([{ text: 'x', citations: ['PMID:1'] }], []);
    expect(figureGrounding(a).score).toBe(1);
  });
});

describe('computationGrounding', () => {
  it('returns the mandatory perfect score when no computed claim bypasses the gate', () => {
    expect(computationGrounding(artifacts())).toMatchObject({ score: 1, pass: true });
  });

  it('fails a computation citation that omits the structured binding', () => {
    const a = artifacts({
      briefing: { verdict: 'watch', sections: [{ id: 's', claims: [{ text: 'Unbound computation', citations: ['COMP:1'] }] }] } as never,
      evidenceById: new Map([['COMP:1', { id: 'COMP:1', kind: 'computation' }]]),
    });
    expect(computationGrounding(a)).toMatchObject({ score: 0, pass: false });
  });

  it('fails a shipped fabricated computed value', () => {
    const raw = {
      schemaVersion: '1.0.0', templateId: 't', templateVersion: '1.0.0',
      target: { symbol: 'X', name: 'X', entrezGeneId: 1, gencodeId: null },
      lockedAnalysis: { method: 'reviewed' },
      results: { x: {
        type: 'scalar', value: 1, unit: 'TPM', comparator: 'none', threshold: null,
        direction: 'not_applicable', precision: 2, tolerance: 0.01,
        missingness: { missingN: 0, observedN: 1, totalN: 1, fraction: 0 },
        sampleN: 1, nullable: false, note: null,
      } },
      artifacts: [{ kind: 'figure', path: 'x.png', mediaType: 'image/png', description: 'x' }], warnings: [],
    };
    const a = artifacts({
      briefing: { verdict: 'watch', sections: [{ id: 's', claims: [{
        text: 'Fabricated 42 TPM', citations: ['COMP:1'],
        computedBinding: { computationId: 'a'.repeat(64), resultKey: 'x', assertedValue: 42, assertedUnit: 'TPM' },
        executionMode: 'live', replayVerification: 'verified', originVerification: 'none',
        llmVerdict: 'supported', verifierDecorrelated: true,
      }] }] } as never,
      evidenceById: new Map([['COMP:1', {
        id: 'COMP:1', kind: 'computation', computationId: 'a'.repeat(64), resultKeys: ['x'],
        resultsJsonHash: sha256CanonicalJson(raw), raw,
        exitStatus: { exitCode: 0, timedOut: false, signal: null },
      }]]),
    });
    expect(computationGrounding(a)).toMatchObject({ score: 0, pass: false });
  });

  it('loads the adversarial fixture and proves the gate drops it against the Slice 1 golden results', () => {
    const fixturePath = fileURLToPath(new URL('../golden/computation/fabricated-output.json', import.meta.url));
    const goldenPath = fileURLToPath(new URL('../../packages/mcp-gateway/src/dataLake/golden/trop2_results.json', import.meta.url));
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      claim: {
        id: string; text: string; citations: string[]; confidence: number;
        computedBinding: { computationId: string; resultKey: string; assertedValue: number; assertedUnit: string };
      };
      expectedGateOutcome: string;
    };
    const results = AnalysisResultsSchema.parse(JSON.parse(readFileSync(goldenPath, 'utf8')));
    const codeBytes = 'print("reviewed")\n';
    const lineageManifest = { id: 'depmap.crispr_gene_effect', release: '24Q4' };
    const dataset = {
      datasetId: 'depmap.crispr_gene_effect', logicalSourceId: 'depmap:public-24q4',
      contentSha256: '53ada942b62a3d78b1784b04599e1b64f4cbe29367224dc9ef055b77b1d43948',
      acquisitionQuery: { gene: 'TACSTD2' }, retrievedAt: '2026-07-17T20:58:39Z',
      lineageManifestHash: sha256CanonicalJson(lineageManifest), lineageManifest,
    };
    const manifest = {
      manifestVersion: '1.0.0' as const, templateId: results.templateId, templateVersion: results.templateVersion,
      datasets: [{
        datasetId: dataset.datasetId, logicalSourceId: dataset.logicalSourceId,
        contentSha256: dataset.contentSha256, acquisitionQuery: dataset.acquisitionQuery,
        retrievedAt: dataset.retrievedAt, lineageManifestHash: dataset.lineageManifestHash,
      }],
      imageDigest: `sha256:${'2'.repeat(64)}`, codeHash: sha256Text(codeBytes), params: { target: 'TACSTD2' }, seed: 1729,
    };
    const id = computationId(manifest);
    const evidence: ComputationEvidence = {
      id: 'COMP:trop2', kind: 'computation', source: 'Sonny analysis', title: 'TROP2', snippet: '', url: '',
      raw: results, retrievedAt: '2026-07-17T20:58:39Z', computationId: id,
      templateId: results.templateId, templateVersion: results.templateVersion, datasetInputs: [dataset],
      imageDigest: manifest.imageDigest, codeBytes, codeHash: manifest.codeHash, params: manifest.params, seed: manifest.seed,
      exitStatus: { exitCode: 0, timedOut: false, signal: null }, resultKeys: [fixture.claim.computedBinding.resultKey],
      resultsJsonHash: sha256CanonicalJson(results),
    };
    const adversarialClaim = {
      ...fixture.claim,
      citations: fixture.claim.citations.map((citation) => citation === '$COMPUTATION_EVIDENCE' ? evidence.id : citation),
      computedBinding: { ...fixture.claim.computedBinding, computationId: id },
    };
    const gated = reproducibilityGate({
      claims: [adversarialClaim], evidence: [evidence], primaryResults: { [id]: results },
      replayResults: { [id]: results }, executionMode: 'live',
    });
    expect(fixture.expectedGateOutcome).toBe('dropped');
    expect(gated.shippable).toEqual([]);
    expect(gated.dropped[0].reason).toContain('asserted value');
  });
});

describe('judge metrics (decorrelated stub)', () => {
  const stub: StructuredModelLike = {
    async generateStructured() { return { verdict: 'supported', rationale: 'ok' } as any; },
  };
  it('faithfulness scores supported claims from the judge', async () => {
    const judge = makeJudge(stub);
    const m = await judge.faithfulness(artifacts());
    expect(m.score).toBe(1);
    expect(m.pass).toBe(true);
  });

  it('unsupportedSentenceRatio exempts abstention and makes no judge calls', async () => {
    let calls = 0;
    const countingStub: StructuredModelLike = {
      async generateStructured() { calls++; return { verdict: 'unsupported', rationale: 'x' } as any; },
    };
    const a = {
      briefing: {
        verdict: 'insufficient-evidence',
        thesis: 'Insufficient verified evidence to assess ABC1.',
        executiveRead: 'Fewer than two verified findings support an assessment; the dossier abstains.',
        bull: [],
        bear: [],
        sections: [],
      },
      evidenceById: new Map(),
      elapsedMs: 1,
    } as any as RunArtifacts;
    const judge = makeJudge(countingStub);
    const m = await judge.unsupportedSentenceRatio(a);
    expect(m.score).toBe(1);
    expect(m.pass).toBe(true);
    expect((m.detail as any).abstained).toBe(true);
    expect(calls).toBe(0);
  });

  it('unsupportedSentenceRatio still scores non-abstention prose via the judge', async () => {
    let calls = 0;
    const countingStub: StructuredModelLike = {
      async generateStructured() { calls++; return { verdict: 'unsupported', rationale: 'x' } as any; },
    };
    const a = {
      briefing: {
        verdict: 'go',
        thesis: 'ABC1 is a validated oncology target with strong genetic support.',
        executiveRead: '',
        bull: [],
        bear: [],
        sections: [{ id: 's', claims: [{ id: 'c1', text: 'ABC1 drives tumor growth', citations: ['PMID:1'] }] }],
      },
      evidenceById: new Map(),
      elapsedMs: 1,
    } as any as RunArtifacts;
    const judge = makeJudge(countingStub);
    const m = await judge.unsupportedSentenceRatio(a);
    expect(calls).toBeGreaterThan(0);
    expect(m.score).toBe(0);
    expect(m.pass).toBe(false);
  });
});
