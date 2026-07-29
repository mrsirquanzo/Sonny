import { describe, expect, it } from 'vitest';
import type { RetrievalAudit } from '@mrsirquanzo/sonny-shared';
import { RetrievalAuditStore } from '@mrsirquanzo/sonny-shared';

const audit = (
  id: string,
  overrides: Partial<RetrievalAudit> = {},
): RetrievalAudit => ({
  id,
  axis: 'clinical_landscape',
  sectionKey: 'clinical_landscape',
  sourceId: 'clinicaltrials',
  queryClass: 'target_modality',
  queryFingerprint: `fingerprint-${id}`,
  normalizedQueryTerms: ['KRAS', 'NSCLC'],
  status: 'completed',
  executedAt: '2026-07-28T12:00:00.000Z',
  rawResultCount: 0,
  relevantResultCount: 0,
  ...overrides,
});

describe('RetrievalAuditStore', () => {
  it('is run-local and resolves registered audits by id', () => {
    const firstRun = new RetrievalAuditStore();
    const secondRun = new RetrievalAuditStore();
    const record = audit('audit-1');

    firstRun.register(record);

    expect(firstRun.has('audit-1')).toBe(true);
    expect(firstRun.get('audit-1')).toEqual(record);
    expect(firstRun.all()).toEqual([record]);

    expect(secondRun.has('audit-1')).toBe(false);
    expect(secondRun.get('audit-1')).toBeUndefined();
    expect(secondRun.all()).toEqual([]);
  });

  it('does not expose a mutable Map as its public result', () => {
    const store = new RetrievalAuditStore();
    store.register(audit('audit-1'));

    const snapshot = store.all();
    snapshot.length = 0;

    expect(store.all()).toHaveLength(1);
    expect(store.has('audit-1')).toBe(true);
  });
});
