import { describe, expect, it } from 'vitest';
import type {
  Claim,
  Evidence,
  SpecialistConclusion,
} from '@mrsirquanzo/sonny-shared';
import { EvidenceStore } from '../evidenceStore.js';
import { evaluateAbstention } from '../conclusions/coverage.js';
import { deriveStructuredClaims } from '../structuredClaims.js';

const verifiedClaim = (id: string): Claim => ({
  id,
  text: `Verified claim ${id}`,
  citations: [`evidence-${id}`],
  confidence: 0.9,
});

const deterministicClaim: Claim = {
  id: 'struct-1',
  text: 'A curated deterministic claim.',
  citations: ['uniprot:KRAS#localization'],
  confidence: 0.9,
  provenance: 'deterministic',
};

const q1 = (
  validity: 'strong' | 'insufficient_evidence',
): SpecialistConclusion => ({
  axis: 'target_biology',
  assessments: [{
    context: {
      canonicalContextId: 'context-1',
      ontologySource: 'MONDO',
      ontologyVersion: '2026-06-02',
      indication: {
        raw: 'NSCLC',
        canonicalName: 'non-small cell lung carcinoma',
        ontologyId: 'MONDO:0005233',
      },
      mappingConfidence: 'exact',
      mappingRelation: 'exact',
    },
    q1HypothesisKey: 'KRAS|disease_driver|suppress_function',
    target: {
      kind: 'gene_or_protein',
      symbol: 'KRAS',
      targetForm: 'G12C',
    },
    targetRole: 'disease_driver',
    biologicalIntent: 'suppress_function',
    validity,
    confidence: validity === 'insufficient_evidence' ? 'low' : 'moderate',
    evidenceAvailability:
      validity === 'insufficient_evidence' ? 'absent' : 'rich',
    support: {
      supportingClaimIds:
        validity === 'insufficient_evidence' ? [] : ['claim-1'],
      evidenceIds:
        validity === 'insufficient_evidence' ? [] : ['evidence-claim-1'],
    },
  }],
});

const q2 = (
  modalityFit: 'strong' | 'insufficient_evidence',
): SpecialistConclusion => modalityFit === 'insufficient_evidence'
  ? {
      axis: 'moa_pathway',
      assessment: {
        modalityFit: 'insufficient_evidence',
        confidence: 'low',
        evidenceGap: 'No modality-feasibility evidence.',
        support: {
          supportingClaimIds: [],
          evidenceIds: [],
        },
      },
    }
  : {
      axis: 'moa_pathway',
      assessment: {
        modalityFit: 'strong',
        weakestLink: {
          mechanisticStatus: 'supported',
          mitigability: 'engineerable',
        },
        confidence: 'moderate',
        mechanisticBottleneck: 'Sustained target engagement.',
        mostDecisiveNextExperiment: 'Measure target engagement.',
        support: {
          supportingClaimIds: ['claim-2'],
          evidenceIds: ['evidence-claim-2'],
        },
      },
    };

const q4Supportive: SpecialistConclusion = {
  axis: 'clinical_landscape',
  assessment: {
    precedent: 'supportive',
    evidenceMaturity: 'clinical',
    confidence: 'moderate',
    support: {
      supportingClaimIds: ['claim-3'],
      evidenceIds: ['evidence-claim-3'],
    },
  },
};

describe('coverage-based abstention', () => {
  it('proceeds with two verified non-deterministic claims and materially covered Q1 and Q2', () => {
    expect(evaluateAbstention({
      conclusions: [q1('strong'), q2('strong')],
      verifiedClaims: [
        verifiedClaim('claim-1'),
        verifiedClaim('claim-2'),
      ],
    })).toEqual({
      proceed: true,
      reasons: [],
    });
  });

  it('does not let deterministic claims satisfy the two-claim threshold', () => {
    const result = evaluateAbstention({
      conclusions: [q1('strong'), q2('strong')],
      verifiedClaims: [
        verifiedClaim('claim-1'),
        deterministicClaim,
      ],
    });

    expect(result.proceed).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('requires two distinct materially covered axes', () => {
    const result = evaluateAbstention({
      conclusions: [q1('strong')],
      verifiedClaims: [
        verifiedClaim('claim-1'),
        verifiedClaim('claim-2'),
      ],
    });

    expect(result.proceed).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('abstains when critical Q1 is insufficient even if two other axes are covered', () => {
    const result = evaluateAbstention({
      conclusions: [
        q1('insufficient_evidence'),
        q2('strong'),
        q4Supportive,
      ],
      verifiedClaims: [
        verifiedClaim('claim-1'),
        verifiedClaim('claim-2'),
      ],
    });

    expect(result.proceed).toBe(false);
    expect(JSON.stringify(result.reasons)).toMatch(
      /Q1|target_biology|critical/i,
    );
  });

  it('abstains when critical Q2 is insufficient even if two other axes are covered', () => {
    const result = evaluateAbstention({
      conclusions: [
        q1('strong'),
        q2('insufficient_evidence'),
        q4Supportive,
      ],
      verifiedClaims: [
        verifiedClaim('claim-1'),
        verifiedClaim('claim-2'),
      ],
    });

    expect(result.proceed).toBe(false);
    expect(JSON.stringify(result.reasons)).toMatch(
      /Q2|moa_pathway|critical/i,
    );
  });
});

const curatedEvidence = (
  id: string,
  source: 'Open Targets' | 'UniProt',
  snippet: string,
): Evidence => ({
  id,
  kind: 'target',
  source,
  title: id,
  snippet,
  url: `https://example.test/${encodeURIComponent(id)}`,
  raw: {},
  retrievedAt: '2026-07-28T12:00:00.000Z',
});

describe('deterministic claim derivation before drafting', () => {
  it('routes one localization card independently to Q1 and Q2', () => {
    const store = new EvidenceStore();
    store.register(curatedEvidence(
      'uniprot:KRAS#localization',
      'UniProt',
      'KRAS is annotated at the plasma membrane.',
    ));

    const derived = deriveStructuredClaims(store);
    const q1Claims = derived.get('target_biology') ?? [];
    const q2Claims = derived.get('moa_pathway') ?? [];

    expect(q1Claims).toHaveLength(1);
    expect(q2Claims).toHaveLength(1);

    expect(q1Claims[0]).toMatchObject({
      citations: ['uniprot:KRAS#localization'],
      provenance: 'deterministic',
    });
    expect(q2Claims[0]).toMatchObject({
      citations: ['uniprot:KRAS#localization'],
      provenance: 'deterministic',
    });

    expect(q1Claims[0].id).not.toBe(q2Claims[0].id);
  });

  it('routes expression to Q3 and Q6 but not to Q2', () => {
    const store = new EvidenceStore();
    store.register(curatedEvidence(
      'opentargets:KRAS#expression',
      'Open Targets',
      'KRAS expression is observed across multiple normal tissues.',
    ));

    const derived = deriveStructuredClaims(store);

    expect(derived.get('disease_indications')).toHaveLength(1);
    expect(derived.get('modality_developability')).toHaveLength(1);
    expect(derived.get('moa_pathway')).toBeUndefined();
  });

  it('does not derive model-style claims from non-curated sources', () => {
    const store = new EvidenceStore();
    store.register({
      ...curatedEvidence(
        'PMID:123#localization',
        'UniProt',
        'A publication-derived localization assertion.',
      ),
      kind: 'publication',
      source: 'Europe PMC',
    });

    expect(deriveStructuredClaims(store).size).toBe(0);
  });
});
