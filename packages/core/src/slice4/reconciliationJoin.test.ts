import { describe, expect, it } from 'vitest';
import {
  normalizeDiseaseContext,
  reconcileContextAssessments,
} from '../index.js';
import type {
  Q1ContextAssessment,
  Q3ContextAssessment,
} from '@mrsirquanzo/sonny-shared';
import { ontologyFixture } from './ontologyFixture.js';

const support = { supportingClaimIds: ['c1'], evidenceIds: ['e1'] };
const context = (indication: string) => normalizeDiseaseContext({ indication }, ontologyFixture);
const q1 = (
  indication: string,
  validity: Q1ContextAssessment['validity'] = 'strong',
  confidence: Q1ContextAssessment['confidence'] = 'high',
  evidenceAvailability: Q1ContextAssessment['evidenceAvailability'] = 'rich',
): Q1ContextAssessment => ({
  context: context(indication),
  q1HypothesisKey: 'q1:kras-driver-suppress',
  target: { kind: 'gene_or_protein', symbol: 'KRAS' },
  targetRole: 'disease_driver',
  biologicalIntent: 'suppress_function',
  validity,
  confidence,
  evidenceAvailability,
  support,
});
const q3 = (
  indication: string,
  opportunity: Q3ContextAssessment['opportunity'] = 'strong',
  confidence: Q3ContextAssessment['confidence'] = 'moderate',
  evidenceAvailability: Q3ContextAssessment['evidenceAvailability'] = 'sparse',
): Q3ContextAssessment => ({
  context: context(indication),
  opportunity,
  confidence,
  evidenceAvailability,
  support,
});

describe('Q1/Q3 reconciliation join', () => {
  it('groups strictly by canonicalContextId and reports both/only-Q1/only-Q3', () => {
    const rows = reconcileContextAssessments(
      [q1('NSCLC'), q1('PDAC')],
      [q3(' non-small-cell lung cancer '), q3('melanoma')],
    );
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.context.canonicalContextId === context('NSCLC').canonicalContextId))
      .toMatchObject({ status: 'evaluated_by_both', q1: expect.any(Object), q3: expect.any(Object) });
    expect(rows.find((row) => row.context.canonicalContextId === context('PDAC').canonicalContextId))
      .toMatchObject({ status: 'only_q1', q1: expect.any(Object) });
    expect(rows.find((row) => row.context.canonicalContextId === context('melanoma').canonicalContextId))
      .toMatchObject({ status: 'only_q3', q3: expect.any(Object) });
  });

  it('reports conflicting favorable/unfavorable assessments', () => {
    const [row] = reconcileContextAssessments(
      [q1('NSCLC', 'strong')],
      [q3('NSCLC', 'unsupported')],
    );
    expect(row.status).toBe('conflicting');
  });

  it('keeps an unresolved context ambiguous and never joins it to a possible match', () => {
    const rows = reconcileContextAssessments(
      [q1('non small lung adenocarcinom')],
      [q3('lung adenocarcinoma')],
    );
    expect(rows.map((row) => row.status).sort()).toEqual(['ambiguous', 'only_q3']);
    const ambiguous = rows.find((row) => row.status === 'ambiguous')!;
    expect(ambiguous.context.mappingConfidence).toBe('unresolved');
  });

  it('carries confidence and evidenceAvailability verbatim outside status', () => {
    const left = q1('NSCLC', 'conditional', 'low', 'absent');
    const right = q3('NSCLC', 'moderate', 'high', 'rich');
    const [row] = reconcileContextAssessments([left], [right]);

    expect(row.q1).toMatchObject({ confidence: 'low', evidenceAvailability: 'absent' });
    expect(row.q3).toMatchObject({ confidence: 'high', evidenceAvailability: 'rich' });
    expect(row.status).not.toContain('low');
    expect(row.status).not.toContain('absent');
    expect(row.status).not.toContain('high');
    expect(row.status).not.toContain('rich');
  });
});
