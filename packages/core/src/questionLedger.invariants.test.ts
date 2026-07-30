import { describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS_PER_QUESTION } from '@mrsirquanzo/sonny-shared';
import { QuestionLedger } from './questionLedger.js';

const planned = [
  { question: 'Question one?', concept: 'one' },
  { question: 'Question two?', concept: 'two' },
  { question: 'Question three?', concept: 'three' },
  { question: 'Question four?', concept: 'four' },
  { question: 'Question five?', concept: 'five' },
];

const attempt = (
  l: QuestionLedger,
  id: string,
  o: Partial<{ claimIds: string[]; retrievalAuditIds: string[]; usableRetrieval: boolean; round: number }> = {},
) => l.recordAttempt(id, {
  claimIds: o.claimIds ?? [],
  retrievalAuditIds: o.retrievalAuditIds ?? [],
  usableRetrieval: o.usableRetrieval ?? true,
  round: o.round ?? 0,
});

describe('QuestionLedger merges rather than replaces', () => {
  // THE defect this ledger exists to fix. `openQuestions = reflection.followups`
  // discarded planned questions 2..5 after round 0, so four of every five
  // questions a specialist set itself were never asked.
  it('keeps planned questions 2-5 after question 1 is answered, and appends follow-ups', () => {
    const l = new QuestionLedger('section');
    l.add(planned, 'planned');
    attempt(l, 'section#q1', { claimIds: ['claim-1'] });
    l.applyGrounding(new Set(['claim-1']));
    l.add([{ question: 'A reflected follow-up?', concept: 'followup' }], 'followup');

    expect(l.open().map((q) => q.id)).toEqual([
      'section#q2', 'section#q3', 'section#q4', 'section#q5', 'section#q6',
    ]);
    expect(l.next()?.id).toBe('section#q2');
  });

  it('pursues every surviving planned question before a later follow-up', () => {
    const l = new QuestionLedger('section');
    l.add(planned, 'planned');
    const pursued: string[] = [];
    let q = l.next();
    while (q) {
      pursued.push(q.id);
      attempt(l, q.id, { claimIds: [`c-${q.id}`], round: pursued.length - 1 });
      l.applyGrounding(new Set([`c-${q.id}`]));
      if (q.id === 'section#q1') l.add([{ question: 'Follow-up after Q1?', concept: 'f' }], 'followup');
      q = l.next();
    }
    expect(pursued).toEqual([
      'section#q1', 'section#q2', 'section#q3', 'section#q4', 'section#q5', 'section#q6',
    ]);
  });

  it('deduplicates on normalized text without resetting the existing record', () => {
    const l = new QuestionLedger('section');
    const [q] = l.add([{ question: 'What is the mechanism?', concept: 'mechanism' }], 'planned');
    attempt(l, q.id, { claimIds: ['claim-1'], round: 3 });
    l.applyGrounding(new Set(['claim-1']));

    expect(l.add([{ question: '  WHAT   IS THE MECHANISM ', concept: 'other' }], 'followup')).toEqual([]);
    expect(l.all()).toEqual([expect.objectContaining({
      id: 'section#q1', concept: 'mechanism', origin: 'planned',
      status: 'answered', attempts: 1, firstAskedRound: 3,
    })]);
  });
});

describe('QuestionLedger deterministic sufficiency', () => {
  it('answers on a grounded claim and stays open when none grounds', () => {
    const l = new QuestionLedger('section');
    l.add(planned.slice(0, 2), 'planned');
    attempt(l, 'section#q1', { claimIds: ['grounded', 'not-grounded'] });
    attempt(l, 'section#q2', { claimIds: ['also-not-grounded'] });
    l.applyGrounding(new Set(['grounded']));
    expect(l.all().map((q) => q.status)).toEqual(['answered', 'open']);
  });

  it('does not let one question claim a grounded claim another drafted', () => {
    const l = new QuestionLedger('section');
    l.add(planned.slice(0, 2), 'planned');
    attempt(l, 'section#q1', { claimIds: ['for-q1'] });
    attempt(l, 'section#q2', { claimIds: ['for-q2'] });
    l.applyGrounding(new Set(['for-q2']));
    expect(l.all().map((q) => q.status)).toEqual(['open', 'answered']);
  });

  it('never returns an answered or exhausted question from next()', () => {
    const l = new QuestionLedger('section');
    l.add(planned.slice(0, 2), 'planned');
    attempt(l, 'section#q1', { claimIds: ['c'] });
    l.applyGrounding(new Set(['c']));
    for (let i = 0; i < MAX_ATTEMPTS_PER_QUESTION; i++) attempt(l, 'section#q2', { usableRetrieval: false });
    expect(l.all().map((q) => q.status)).toEqual(['answered', 'unanswered_exhausted']);
    expect(l.next()).toBeUndefined();
  });
});

describe('QuestionLedger post-verification reconciliation', () => {
  it('reopens a question whose answering claims all failed verification', () => {
    const l = new QuestionLedger('section');
    const [q] = l.add([planned[0]], 'planned');
    attempt(l, q.id, { claimIds: ['c1', 'c2'] });
    l.applyGrounding(new Set(['c1', 'c2']));
    l.applyVerification(new Set());
    expect(l.all()[0].status).toBe('open');
    expect(l.next()?.id).toBe(q.id);
  });

  it('keeps it answered when one answering claim survives', () => {
    const l = new QuestionLedger('section');
    const [q] = l.add([planned[0]], 'planned');
    attempt(l, q.id, { claimIds: ['c1', 'c2'] });
    l.applyGrounding(new Set(['c1', 'c2']));
    l.applyVerification(new Set(['c2']));
    expect(l.all()[0].status).toBe('answered');
  });

  it('does not promote a question that never grounded', () => {
    const l = new QuestionLedger('section');
    const [q] = l.add([planned[0]], 'planned');
    attempt(l, q.id, { claimIds: ['c1'] });
    l.applyGrounding(new Set());
    l.applyVerification(new Set(['c1']));
    expect(l.all()[0].status).toBe('open');
  });
});

describe('QuestionLedger exhaustion is bounded by attempts', () => {
  it('does not exhaust before MAX_ATTEMPTS_PER_QUESTION', () => {
    const l = new QuestionLedger('section');
    const [q] = l.add([planned[0]], 'planned');
    for (let i = 1; i < MAX_ATTEMPTS_PER_QUESTION; i++) {
      attempt(l, q.id, { usableRetrieval: false, round: i - 1 });
      expect(l.all()[0].status).toBe('open');
    }
  });

  // Deliberate divergence from the independently-authored suite, which expected
  // usable-but-ungrounded attempts to leave a question open indefinitely. That
  // lets one stubborn question consume the whole round budget - the exact
  // failure this ledger replaces. Exhaustion is bounded by attempts; the REASON
  // lives in `unusableAttempts`.
  it('exhausts after MAX attempts even when retrieval was usable every time', () => {
    const l = new QuestionLedger('section');
    const [q] = l.add([planned[0]], 'planned');
    for (let i = 0; i < MAX_ATTEMPTS_PER_QUESTION; i++) {
      attempt(l, q.id, { claimIds: [`ungrounded-${i}`], usableRetrieval: true, round: i });
      l.applyGrounding(new Set());
    }
    expect(l.all()[0]).toEqual(expect.objectContaining({
      status: 'unanswered_exhausted',
      attempts: MAX_ATTEMPTS_PER_QUESTION,
      unusableAttempts: 0,
    }));
    expect(l.next()).toBeUndefined();
  });

  it('records unusableAttempts so the reason stays distinguishable', () => {
    const l = new QuestionLedger('section');
    const [q] = l.add([planned[0]], 'planned');
    for (let i = 0; i < MAX_ATTEMPTS_PER_QUESTION; i++) attempt(l, q.id, { usableRetrieval: false, round: i });
    expect(l.all()[0].unusableAttempts).toBe(MAX_ATTEMPTS_PER_QUESTION);
  });

  it('lets a later grounded claim override exhaustion', () => {
    const l = new QuestionLedger('section');
    const [q] = l.add([planned[0]], 'planned');
    attempt(l, q.id, { claimIds: ['late'], usableRetrieval: false });
    attempt(l, q.id, { usableRetrieval: false, round: 1 });
    expect(l.all()[0].status).toBe('unanswered_exhausted');
    l.applyGrounding(new Set(['late']));
    expect(l.all()[0].status).toBe('answered');
  });

  it('unanswered() returns both open and exhausted', () => {
    const l = new QuestionLedger('section');
    l.add(planned.slice(0, 3), 'planned');
    attempt(l, 'section#q1', { claimIds: ['c'] });
    l.applyGrounding(new Set(['c']));
    for (let i = 0; i < MAX_ATTEMPTS_PER_QUESTION; i++) attempt(l, 'section#q2', { usableRetrieval: false });
    expect(l.unanswered().map((q) => q.id)).toEqual(['section#q2', 'section#q3']);
  });
});

describe('QuestionLedger boundaries', () => {
  it('throws on an unknown question id rather than losing a round of work', () => {
    const l = new QuestionLedger('section');
    expect(() => attempt(l, 'section#q99')).toThrow(/unknown question id/);
  });

  it('hands out copies so a caller cannot bypass the invariants', () => {
    const l = new QuestionLedger('section');
    l.add([planned[0]], 'planned');
    const handed = l.next()!;
    handed.status = 'answered';
    expect(l.all()[0].status).toBe('open');
  });
});
