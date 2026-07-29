import { describe, expect, it } from 'vitest';
import type {
  Claim,
  DiseaseContextKey,
  Evidence,
  SpecialistExecutionContext,
  TraceEvent,
} from '@mrsirquanzo/sonny-shared';
import { SpecialistConclusionSchema } from '@mrsirquanzo/sonny-shared';
import { EvidenceStore } from '../evidenceStore.js';
import type { StructuredModel } from '../model.js';
import type { ThreadBrief } from '../researcher.js';
import { RetrievalAuditStore } from '@mrsirquanzo/sonny-shared';
import { draftSpecialistConclusion } from '../conclusions/draft.js';
import { normalizeDiseaseContext } from '../diseaseContext.js';
import { ontologyFixture } from '../slice4/ontologyFixture.js';

const contextKey: DiseaseContextKey = normalizeDiseaseContext(
  { indication: 'NSCLC' },
  ontologyFixture,
);

const brief: ThreadBrief = {
  id: 'disease_indications',
  title: 'Indication and biomarker prioritization',
  objective: 'Rank relevant disease contexts.',
  promptHint: 'Compare contexts without assuming target validity.',
  scope: { kind: 'shared' },
  context: {
    kind: 'shared',
    queryScope: {
      subjectTargets: [{
        kind: 'gene_or_protein',
        symbol: 'KRAS',
      }],
      indication: 'NSCLC',
      rawPrompt: 'Evaluate KRAS in NSCLC.',
    },
  },
};

const executionContext: SpecialistExecutionContext = {
  kind: 'shared',
  queryScope: {
    subjectTargets: [{
      kind: 'gene_or_protein',
      symbol: 'KRAS',
    }],
    indication: 'NSCLC',
    rawPrompt: 'Evaluate KRAS in NSCLC.',
  },
};

const verifiedClaim: Claim = {
  id: 'disease_indications::shared#r1c1',
  text: 'KRAS G12C is recurrent in a biomarker-defined NSCLC population.',
  citations: ['PMID:verified'],
  confidence: 0.9,
};

const deterministicClaim: Claim = {
  id: 'struct-1-disease_indications',
  text: 'Open Targets records KRAS associations with lung carcinoma.',
  citations: ['opentargets:KRAS#expression'],
  confidence: 0.9,
  provenance: 'deterministic',
};

const evidence = (id: string): Evidence => ({
  id,
  kind: 'publication',
  source: 'Europe PMC',
  title: id,
  snippet: `Evidence for ${id}.`,
  url: `https://example.test/${encodeURIComponent(id)}`,
  raw: {},
  retrievedAt: '2026-07-28T12:00:00.000Z',
});

describe('draftSpecialistConclusion', () => {
  it('runs one model call and exposes only supplied surviving and deterministic claims', async () => {
    const calls: Array<{
      system: string;
      prompt: string;
      model: string;
    }> = [];

    const model: StructuredModel = {
      async generateStructured(opts) {
        calls.push({
          system: opts.system,
          prompt: opts.prompt,
          model: opts.model,
        });

        return {
          axis: 'disease_indications',
          conclusion: {
            mode: 'comparative',
            assessments: [{
              context: contextKey,
              rankedStrategies: [{
                strategyFingerprint: 'strategy-1',
                opportunity: 'strong',
                rank: 1,
                confidence: 'moderate',
                evidenceAvailability: 'rich',
                support: {
                  supportingClaimIds: [
                    verifiedClaim.id,
                    deterministicClaim.id,
                  ],
                  evidenceIds: [
                    'MODEL_MUST_NOT_CONTROL_THIS_NAMESPACE',
                  ],
                },
              }],
              winningStrategyFingerprint: 'strategy-1',
            }],
          },
        } as never;
      },
    };

    const store = new EvidenceStore();
    store.register(evidence('PMID:verified'));
    store.register({
      ...evidence('opentargets:KRAS#expression'),
      kind: 'target',
      source: 'Open Targets',
    });

    const events: TraceEvent[] = [];
    const result = await draftSpecialistConclusion({
      brief,
      context: executionContext,
      verifiedClaims: [verifiedClaim],
      deterministicClaims: [deterministicClaim],
      store,
      auditStore: new RetrievalAuditStore(),
      model,
      emit: (event) => events.push(event),
    });

    expect(calls).toHaveLength(1);

    const modelInput = `${calls[0].system}\n${calls[0].prompt}`;
    expect(modelInput).toContain(verifiedClaim.id);
    expect(modelInput).toContain(verifiedClaim.text);
    expect(modelInput).toContain(deterministicClaim.id);
    expect(modelInput).toContain(deterministicClaim.text);
    expect(modelInput).not.toContain('rejected-claim');
    expect(modelInput).not.toContain('rejected evidence');

    expect(
      SpecialistConclusionSchema.safeParse(result).success,
    ).toBe(true);

    expect(result.axis).toBe('disease_indications');
    if (result.axis !== 'disease_indications') {
      throw new Error('unexpected axis');
    }

    const ranked = result.conclusion.assessments[0].rankedStrategies[0];

    expect(ranked.support.supportingClaimIds).toEqual([
      verifiedClaim.id,
      deterministicClaim.id,
    ]);
    expect(ranked.support.evidenceIds).toEqual([
      'PMID:verified',
      'opentargets:KRAS#expression',
    ]);
    expect(ranked.support.evidenceIds).not.toContain(
      'MODEL_MUST_NOT_CONTROL_THIS_NAMESPACE',
    );
  });

  it('does not allow a model to cite a claim outside the supplied claim set', async () => {
    const model: StructuredModel = {
      async generateStructured() {
        return {
          axis: 'disease_indications',
          conclusion: {
            mode: 'comparative',
            assessments: [{
              context: contextKey,
              rankedStrategies: [{
                strategyFingerprint: 'strategy-1',
                opportunity: 'strong',
                rank: 1,
                confidence: 'high',
                evidenceAvailability: 'rich',
                support: {
                  supportingClaimIds: ['rejected-claim'],
                  evidenceIds: ['phantom-evidence'],
                },
              }],
              winningStrategyFingerprint: 'strategy-1',
            }],
          },
        } as never;
      },
    };

    const result = await draftSpecialistConclusion({
      brief,
      context: executionContext,
      verifiedClaims: [verifiedClaim],
      deterministicClaims: [deterministicClaim],
      store: new EvidenceStore(),
      auditStore: new RetrievalAuditStore(),
      model,
      emit: () => {},
    });

    expect(result.axis).toBe('disease_indications');
    if (result.axis !== 'disease_indications') {
      throw new Error('unexpected axis');
    }

    const ranked = result.conclusion.assessments[0].rankedStrategies[0];

    expect(ranked.opportunity).toBe('insufficient_evidence');
    expect(ranked.confidence).toBe('low');
    expect(ranked.support.supportingClaimIds).not.toContain(
      'rejected-claim',
    );
    expect(ranked.support.evidenceIds).not.toContain('phantom-evidence');
  });
});
