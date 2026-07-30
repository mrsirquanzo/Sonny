import { describe, expect, it } from 'vitest';
import type {
  Claim,
  Evidence,
  RetrievalAudit,
  SpecialistConclusion,
  TraceEvent,
} from '@mrsirquanzo/sonny-shared';
import { SpecialistConclusionSchema } from '@mrsirquanzo/sonny-shared';
import { EvidenceStore } from '../evidenceStore.js';
import { RetrievalAuditStore } from '@mrsirquanzo/sonny-shared';
import {
  deriveEvidenceIds,
  validateAndDegrade,
} from '../conclusions/validate.js';

const claim = (
  id: string,
  citations: string[],
  provenance?: 'deterministic',
): Claim => ({
  id,
  text: `Claim ${id}`,
  citations,
  confidence: 0.9,
  ...(provenance ? { provenance } : {}),
});

const evidence = (id: string): Evidence => ({
  id,
  kind: 'publication',
  source: 'Europe PMC',
  title: `Evidence ${id}`,
  snippet: `Evidence passage for ${id}.`,
  url: `https://example.test/${encodeURIComponent(id)}`,
  raw: {},
  retrievedAt: '2026-07-28T12:00:00.000Z',
});

const audit = (
  id: string,
  sourceId: RetrievalAudit['sourceId'],
  queryClass: RetrievalAudit['queryClass'],
  overrides: Partial<RetrievalAudit> = {},
): RetrievalAudit => ({
  id,
  axis: 'clinical_landscape',
  sectionKey: 'clinical_landscape',
  sourceId,
  queryClass,
  queryFingerprint: `fingerprint-${id}`,
  normalizedQueryTerms: ['KRAS', 'NSCLC'],
  status: 'completed',
  executedAt: '2026-07-28T12:00:00.000Z',
  rawResultCount: 0,
  relevantResultCount: 0,
  ...overrides,
});

function registerAdequateQ4Coverage(store: RetrievalAuditStore): string[] {
  const audits: RetrievalAudit[] = [];
  const sources = [
    'clinicaltrials',
    'europepmc',
    'opentargets',
  ] as const;
  const queryClasses = [
    'target_modality',
    'target_class_precedent',
  ] as const;

  for (const sourceId of sources) {
    for (const queryClass of queryClasses) {
      audits.push(audit(`${sourceId}-${queryClass}`, sourceId, queryClass));
    }
  }

  for (const record of audits) {
    store.register(record);
  }

  return audits.map((record) => record.id);
}

const assessedQ2 = (
  supportingClaimIds: string[],
): SpecialistConclusion => ({
  axis: 'moa_pathway',
  assessment: {
    modalityFit: 'conditional',
    weakestLink: {
      mechanisticStatus: 'conditional',
      mitigability: 'engineerable',
    },
    confidence: 'moderate',
    mechanisticBottleneck: 'Sustained intracellular target engagement.',
    mostDecisiveNextExperiment:
      'Measure target engagement and pathway suppression.',
    support: {
      supportingClaimIds,
      evidenceIds: ['model-authored-evidence-id'],
    },
  },
});

const absentQ4 = (
  retrievalAuditIds?: string[],
): SpecialistConclusion => ({
  axis: 'clinical_landscape',
  assessment: {
    precedent: 'absent',
    confidence: 'moderate',
    support: {
      supportingClaimIds: [],
      evidenceIds: [],
      ...(retrievalAuditIds ? { retrievalAuditIds } : {}),
    },
  },
});

describe('support validation and degradation', () => {
  it('degrades when every referenced supporting claim failed verification', () => {
    const result = validateAndDegrade({
      conclusion: assessedQ2(['rejected-claim-1', 'rejected-claim-2']),
      verifiedClaims: [],
      store: new EvidenceStore(),
      auditStore: new RetrievalAuditStore(),
      emit: () => {},
    });

    expect(result.axis).toBe('moa_pathway');
    if (result.axis !== 'moa_pathway') {
      throw new Error('unexpected axis');
    }

    expect(result.assessment).toMatchObject({
      modalityFit: 'insufficient_evidence',
      confidence: 'low',
    });
    expect(result.assessment).toHaveProperty('evidenceGap');
    expect(result.assessment).not.toHaveProperty('mechanisticBottleneck');
    expect(result.assessment).not.toHaveProperty('mostDecisiveNextExperiment');
    expect(
      SpecialistConclusionSchema.safeParse(result).success,
    ).toBe(true);
  });

  it('retains deterministic claims as valid conclusion support', () => {
    const store = new EvidenceStore();
    store.register(evidence('uniprot:KRAS#localization'));

    const result = validateAndDegrade({
      conclusion: assessedQ2(['deterministic-claim']),
      verifiedClaims: [
        claim(
          'deterministic-claim',
          ['uniprot:KRAS#localization'],
          'deterministic',
        ),
      ],
      store,
      auditStore: new RetrievalAuditStore(),
      emit: () => {},
    });

    expect(result.axis).toBe('moa_pathway');
    if (result.axis !== 'moa_pathway') {
      throw new Error('unexpected axis');
    }

    expect(result.assessment.modalityFit).toBe('conditional');
    expect(result.assessment.support).toEqual({
      supportingClaimIds: ['deterministic-claim'],
      evidenceIds: ['uniprot:KRAS#localization'],
    });
  });
});

describe('derived evidence ids', () => {
  it('derives stable, unique evidence ids from supporting claim citations', () => {
    const store = new EvidenceStore();
    store.register(evidence('evidence-1'));
    store.register(evidence('evidence-2'));

    expect(deriveEvidenceIds(
      [
        claim('claim-1', ['evidence-1', 'evidence-2']),
        claim('claim-2', ['evidence-2', 'evidence-1']),
      ],
      ['claim-1', 'claim-2'],
      store,
    )).toEqual({
      evidenceIds: ['evidence-1', 'evidence-2'],
      dropped: [],
    });
  });

  it('drops citations that do not resolve in the evidence store', () => {
    const store = new EvidenceStore();
    store.register(evidence('evidence-1'));

    expect(deriveEvidenceIds(
      [claim('claim-1', ['evidence-1', 'phantom-evidence'])],
      ['claim-1'],
      store,
    )).toEqual({
      evidenceIds: ['evidence-1'],
      dropped: ['phantom-evidence'],
    });
  });

  it('overwrites model-authored evidenceIds and traces unresolvable citations', () => {
    const store = new EvidenceStore();
    store.register(evidence('evidence-1'));

    const events: TraceEvent[] = [];
    const conclusion = assessedQ2(['claim-1']);

    if (conclusion.axis !== 'moa_pathway') {
      throw new Error('unexpected axis');
    }
    conclusion.assessment.support.evidenceIds = [
      'model-authored-evidence-id',
    ];

    const result = validateAndDegrade({
      conclusion,
      verifiedClaims: [
        claim('claim-1', ['evidence-1', 'phantom-evidence']),
      ],
      store,
      auditStore: new RetrievalAuditStore(),
      emit: (event) => events.push(event),
    });

    expect(result.axis).toBe('moa_pathway');
    if (result.axis !== 'moa_pathway') {
      throw new Error('unexpected axis');
    }

    expect(result.assessment.support.evidenceIds).toEqual(['evidence-1']);
    expect(result.assessment.support.evidenceIds).not.toContain(
      'model-authored-evidence-id',
    );

    const trace = JSON.stringify(events);
    expect(trace).toContain('phantom-evidence');
    expect(trace).toMatch(/drop|unresolv|missing/i);
  });
});

describe('Q4 absence support', () => {
  it('degrades absent precedent without retrievalAuditIds', () => {
    const result = validateAndDegrade({
      conclusion: absentQ4(),
      verifiedClaims: [],
      store: new EvidenceStore(),
      auditStore: new RetrievalAuditStore(),
      emit: () => {},
    });

    expect(result.axis).toBe('clinical_landscape');
    if (result.axis !== 'clinical_landscape') {
      throw new Error('unexpected axis');
    }

    expect(result.assessment).toMatchObject({
      precedent: 'insufficient_evidence',
      confidence: 'low',
    });
  });

  it('survives with adequate audits and empty supportingClaimIds', () => {
    const auditStore = new RetrievalAuditStore();
    const auditIds = registerAdequateQ4Coverage(auditStore);

    const result = validateAndDegrade({
      conclusion: absentQ4(auditIds),
      verifiedClaims: [],
      store: new EvidenceStore(),
      auditStore,
      emit: () => {},
    });

    expect(result).toEqual(absentQ4(auditIds));
    expect(result.axis).toBe('clinical_landscape');

    if (result.axis !== 'clinical_landscape') {
      throw new Error('unexpected axis');
    }

    expect(result.assessment.precedent).toBe('absent');
    expect(result.assessment.support.supportingClaimIds).toEqual([]);
    expect(result.assessment.support.retrievalAuditIds).toEqual(auditIds);
  });

  it('drops every unresolved retrievalAuditId and traces the drop', () => {
    const auditStore = new RetrievalAuditStore();
    const auditIds = registerAdequateQ4Coverage(auditStore);
    const events: TraceEvent[] = [];

    const result = validateAndDegrade({
      conclusion: absentQ4([...auditIds, 'missing-audit']),
      verifiedClaims: [],
      store: new EvidenceStore(),
      auditStore,
      emit: (event) => events.push(event),
    });

    expect(result.axis).toBe('clinical_landscape');
    if (result.axis !== 'clinical_landscape') {
      throw new Error('unexpected axis');
    }

    expect(result.assessment.precedent).toBe('absent');
    expect(result.assessment.support.retrievalAuditIds).toEqual(auditIds);
    expect(result.assessment.support.retrievalAuditIds).not.toContain(
      'missing-audit',
    );

    const trace = JSON.stringify(events);
    expect(trace).toContain('missing-audit');
    expect(trace).toMatch(/drop|unresolv|missing/i);
  });

  it('degrades when unresolved audit ids leave inadequate coverage', () => {
    const auditStore = new RetrievalAuditStore();
    auditStore.register(audit(
      'clinicaltrials-target-modality',
      'clinicaltrials',
      'target_modality',
    ));

    const result = validateAndDegrade({
      conclusion: absentQ4([
        'clinicaltrials-target-modality',
        'missing-europepmc-audit',
        'missing-opentargets-audit',
      ]),
      verifiedClaims: [],
      store: new EvidenceStore(),
      auditStore,
      emit: () => {},
    });

    expect(result.axis).toBe('clinical_landscape');
    if (result.axis !== 'clinical_landscape') {
      throw new Error('unexpected axis');
    }

    expect(result.assessment).toMatchObject({
      precedent: 'insufficient_evidence',
      confidence: 'low',
    });
    expect(
      result.assessment.support.retrievalAuditIds,
    ).toEqual(['clinicaltrials-target-modality']);
  });

  it('does not count failed audit records toward absence coverage', () => {
    const auditStore = new RetrievalAuditStore();
    const auditIds = registerAdequateQ4Coverage(auditStore);

    const failedId = 'opentargets-target-class-precedent';
    const replacementStore = new RetrievalAuditStore();

    for (const id of auditIds) {
      const record = auditStore.get(id);
      if (!record) throw new Error(`missing fixture audit ${id}`);

      replacementStore.register(
        id === failedId
          ? { ...record, status: 'failed' }
          : record,
      );
    }

    const result = validateAndDegrade({
      conclusion: absentQ4(auditIds),
      verifiedClaims: [],
      store: new EvidenceStore(),
      auditStore: replacementStore,
      emit: () => {},
    });

    expect(result.axis).toBe('clinical_landscape');
    if (result.axis !== 'clinical_landscape') {
      throw new Error('unexpected axis');
    }

    // Codex's suite expected degradation here. Resolved in favour of the
    // shipped `evaluateRetrievalCoverage`, whose documented rule is that a
    // `failed` audit never COUNTS toward a requirement - not that it poisons
    // one. This fixture registers 3 sources x 2 query classes, so failing one
    // opentargets audit still leaves opentargets covered by its other
    // completed audit, and both required query classes covered elsewhere.
    // Redundant coverage surviving a single failed search is the intended
    // behaviour; see the decisive case below.
    expect(result.assessment.precedent).toBe('absent');
  });

  it('degrades when failing audits leave a required source group uncovered', () => {
    const auditStore = new RetrievalAuditStore();
    const auditIds = registerAdequateQ4Coverage(auditStore);
    const replacementStore = new RetrievalAuditStore();

    // Fail EVERY opentargets audit, so no completed audit covers that required
    // source group. This is the case where an absence genuinely cannot stand.
    for (const id of auditIds) {
      const record = auditStore.get(id);
      if (!record) throw new Error(`missing fixture audit ${id}`);
      replacementStore.register(
        record.sourceId === 'opentargets' ? { ...record, status: 'failed' } : record,
      );
    }

    const result = validateAndDegrade({
      conclusion: absentQ4(auditIds),
      verifiedClaims: [],
      store: new EvidenceStore(),
      auditStore: replacementStore,
      emit: () => {},
    });

    expect(result.axis).toBe('clinical_landscape');
    if (result.axis !== 'clinical_landscape') throw new Error('unexpected axis');
    expect(result.assessment.precedent).toBe('insufficient_evidence');
    expect(result.assessment.confidence).toBe('low');
  });
});
