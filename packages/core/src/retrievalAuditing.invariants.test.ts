import { describe, expect, it } from 'vitest';
import {
  ABSENCE_COVERAGE_REQUIREMENTS,
  RetrievalAuditSchema,
  RetrievalAuditStore,
  evaluateRetrievalCoverage,
} from '@mrsirquanzo/sonny-shared';
import { buildRetrievalAudit, queryClassForAxis, sourceForTool } from './retrievalAuditing.js';

const base = {
  axis: 'clinical_landscape',
  sectionKey: 'clinical_landscape',
  toolName: 'europepmc_search',
  renderedQuery: 'CDCP1 AND precedent',
  normalizedQueryTerms: ['CDCP1', 'precedent'],
  rawResultCount: 12,
  relevantResultCount: 4,
  executedAt: '2026-07-30T12:00:00.000Z',
};

describe('retrieval audit construction', () => {
  it('produces a schema-valid audit', () => {
    const audit = buildRetrievalAudit(base)!;
    expect(RetrievalAuditSchema.safeParse(audit).success).toBe(true);
    expect(audit.sourceId).toBe('europepmc');
    expect(audit.queryClass).toBe('target_class_precedent');
    expect(audit.status).toBe('completed');
  });

  it('is deterministic: the same executed query yields the same id and fingerprint', () => {
    const a = buildRetrievalAudit(base)!;
    const b = buildRetrievalAudit({ ...base, executedAt: '2026-07-30T13:00:00.000Z' })!;
    expect(b.id).toBe(a.id);
    expect(b.queryFingerprint).toBe(a.queryFingerprint);
  });

  it('distinguishes a different query', () => {
    const a = buildRetrievalAudit(base)!;
    const b = buildRetrievalAudit({ ...base, renderedQuery: 'CDCP1 AND resistance' })!;
    expect(b.queryFingerprint).not.toBe(a.queryFingerprint);
  });

  // A search that returned hits none of which survived the relevance gate RAN
  // but did not cover the question. `evaluateRetrievalCoverage` refuses to let
  // `partial` satisfy a required source, which is the whole point of the split.
  it('marks a search whose hits all failed the relevance gate as partial', () => {
    const audit = buildRetrievalAudit({ ...base, rawResultCount: 9, relevantResultCount: 0 })!;
    expect(audit.status).toBe('partial');
  });

  it('marks a genuinely empty search as completed, because it is a real result', () => {
    const audit = buildRetrievalAudit({ ...base, rawResultCount: 0, relevantResultCount: 0 })!;
    expect(audit.status).toBe('completed');
  });

  it('marks a failed search as failed regardless of counts', () => {
    const audit = buildRetrievalAudit({ ...base, failed: true })!;
    expect(audit.status).toBe('failed');
  });

  // A fabricated audit is worse than a missing one: it looks like coverage.
  it('returns undefined rather than guessing for an unmapped axis or tool', () => {
    expect(buildRetrievalAudit({ ...base, axis: 'not_an_axis' })).toBeUndefined();
    expect(buildRetrievalAudit({ ...base, toolName: 'mystery_tool' })).toBeUndefined();
    expect(buildRetrievalAudit({ ...base, normalizedQueryTerms: ['  '] })).toBeUndefined();
  });

  it('maps every axis to a query class and known tools to controlled sources', () => {
    for (const axis of [
      'target_biology', 'moa_pathway', 'disease_indications',
      'clinical_landscape', 'competitive_ip', 'modality_developability',
    ]) {
      expect(queryClassForAxis(axis)).toBeDefined();
    }
    expect(sourceForTool('europepmc_search')).toBe('europepmc');
    expect(sourceForTool('opentargets_target')).toBe('opentargets');
    expect(sourceForTool('nope')).toBeUndefined();
  });
});

describe('audits actually satisfy the coverage evaluator', () => {
  it('a real audit set is accepted by the Q4 absence requirement it was built for', () => {
    const store = new RetrievalAuditStore();
    const specs = [
      { toolName: 'clinicaltrials_search', axis: 'clinical_landscape', renderedQuery: 'CDCP1 trials' },
      { toolName: 'europepmc_search', axis: 'clinical_landscape', renderedQuery: 'CDCP1 precedent' },
      { toolName: 'opentargets_target', axis: 'clinical_landscape', renderedQuery: 'CDCP1 target' },
    ];
    for (const spec of specs) {
      const audit = buildRetrievalAudit({ ...base, ...spec })!;
      store.register(audit);
    }

    const result = evaluateRetrievalCoverage({
      requirement: ABSENCE_COVERAGE_REQUIREMENTS.q4_precedent_absent,
      audits: store.all(),
      sectionKey: 'clinical_landscape',
      axis: 'clinical_landscape',
    });

    // The axis produces `target_class_precedent`; `target_modality` is a class
    // its own searches do not generate, so coverage is legitimately incomplete
    // until that search is run explicitly. Asserting the mechanism, not a pass.
    expect(result.missingSourceGroups).toEqual([]);
    expect(result.missingQueryClasses).toEqual(['target_modality']);
  });

  it('a partial audit does not satisfy a required source', () => {
    const store = new RetrievalAuditStore();
    store.register(buildRetrievalAudit({
      ...base, toolName: 'clinicaltrials_search', rawResultCount: 5, relevantResultCount: 0,
    })!);
    const result = evaluateRetrievalCoverage({
      requirement: ABSENCE_COVERAGE_REQUIREMENTS.q4_precedent_absent,
      audits: store.all(),
      sectionKey: 'clinical_landscape',
      axis: 'clinical_landscape',
    });
    expect(result.partialAuditIds).toHaveLength(1);
    expect(result.missingSourceGroups.some((g) => g.includes('clinicaltrials'))).toBe(true);
  });
});

describe('a tool outage must never become evidence of absence', () => {
  it('records a failed search as failed, not as a completed empty one', () => {
    const failed = buildRetrievalAudit({ ...base, rawResultCount: 0, relevantResultCount: 0, failed: true })!;
    const genuinelyEmpty = buildRetrievalAudit({ ...base, rawResultCount: 0, relevantResultCount: 0 })!;
    // Same counts, opposite meaning. Before this split, a timeout and a real
    // search that found nothing produced the identical record - and the second
    // is exactly what an absence conclusion is entitled to stand on.
    expect(failed.status).toBe('failed');
    expect(genuinelyEmpty.status).toBe('completed');
  });

  it('a failed audit cannot satisfy a coverage requirement', () => {
    const store = new RetrievalAuditStore();
    for (const spec of [
      { toolName: 'clinicaltrials_search', renderedQuery: 'CDCP1 trials' },
      { toolName: 'europepmc_search', renderedQuery: 'CDCP1 precedent' },
      { toolName: 'opentargets_target', renderedQuery: 'CDCP1 target' },
    ]) {
      store.register(buildRetrievalAudit({ ...base, ...spec, failed: true, rawResultCount: 0, relevantResultCount: 0 })!);
    }
    const result = evaluateRetrievalCoverage({
      requirement: ABSENCE_COVERAGE_REQUIREMENTS.q4_precedent_absent,
      audits: store.all(),
      sectionKey: 'clinical_landscape',
      axis: 'clinical_landscape',
    });
    expect(result.adequate).toBe(false);
    expect(result.failedAuditIds).toHaveLength(3);
  });
});
