import { describe, expect, it } from 'vitest';
import {
  questionCoverage, questionPursuit, retrievalYield,
  type QuestionRecordLike, type RunArtifacts,
} from './metrics.js';

const record = (o: Partial<QuestionRecordLike>): QuestionRecordLike => ({
  id: 'section#q1', status: 'open', attempts: 0, unusableAttempts: 0, ...o,
});

const artifacts = (ledger?: QuestionRecordLike[]): RunArtifacts => ({
  briefing: {
    verdict: 'watch',
    sections: [{ id: 'target_biology', claims: [], ...(ledger ? { questionLedger: ledger } : {}) }],
  },
  evidenceById: new Map(),
  elapsedMs: 1,
});

describe('question_coverage', () => {
  it('is the share of questions answered', () => {
    const r = questionCoverage(artifacts([
      record({ id: 'q1', status: 'answered', attempts: 1 }),
      record({ id: 'q2', status: 'unanswered_exhausted', attempts: 2 }),
      record({ id: 'q3', status: 'open' }),
      record({ id: 'q4', status: 'answered', attempts: 1 }),
    ]));
    expect(r.score).toBe(0.5);
    expect(r.detail).toEqual({ answered: 2, exhausted: 1, open: 1, total: 4 });
  });

  // Scoring an absent ledger 1.0 would make the metric read best exactly where
  // it knows least, which is how a hollow PASS gets reported as a real one.
  it('scores a missing ledger zero rather than perfect', () => {
    const r = questionCoverage(artifacts());
    expect(r.score).toBe(0);
    expect(r.pass).toBe(false);
  });
});

describe('question_pursuit', () => {
  it('separates never-attempted from attempted-and-failed', () => {
    const r = questionPursuit(artifacts([
      record({ id: 'q1', status: 'answered', attempts: 1 }),
      record({ id: 'q2', status: 'unanswered_exhausted', attempts: 2 }),
      record({ id: 'q3', status: 'open', attempts: 0 }),
      record({ id: 'q4', status: 'open', attempts: 0 }),
    ]));
    expect(r.score).toBe(0.5);
    expect(r.detail).toMatchObject({ attempted: 2, neverAttempted: 2 });
  });

  // The condition that made maxRounds:4 invisible before the ledger existed:
  // a full plan, none of it pursued.
  it('reports zero when the round budget consumed nothing', () => {
    const r = questionPursuit(artifacts([
      record({ id: 'q1' }), record({ id: 'q2' }), record({ id: 'q3' }),
    ]));
    expect(r.score).toBe(0);
    expect(r.pass).toBe(false);
  });
});

describe('retrieval_yield', () => {
  it('is the share of attempts where retrieval returned something usable', () => {
    const r = retrievalYield(artifacts([
      record({ id: 'q1', attempts: 2, unusableAttempts: 1 }),
      record({ id: 'q2', attempts: 2, unusableAttempts: 0 }),
    ]));
    expect(r.score).toBe(0.75);
    expect(r.detail).toEqual({ attempts: 4, usable: 3, unusable: 1 });
  });

  // The point of the split: high yield with low coverage blames extraction,
  // low yield blames retrieval. One undifferentiated failure tells you neither.
  it('stays high when retrieval worked but nothing was answered', () => {
    const ledger = [record({ id: 'q1', status: 'unanswered_exhausted', attempts: 2, unusableAttempts: 0 })];
    expect(retrievalYield(artifacts(ledger)).score).toBe(1);
    expect(questionCoverage(artifacts(ledger)).score).toBe(0);
  });

  it('scores no recorded attempts zero', () => {
    expect(retrievalYield(artifacts([record({ id: 'q1' })])).score).toBe(0);
  });
});
