import {
  MAX_ATTEMPTS_PER_QUESTION,
  type ResearchQuestionRecord,
} from '@mrsirquanzo/sonny-shared';

/**
 * The record of what a specialist asked, what it answered, and what it could not.
 *
 * Replaces a queue that was reassigned every round. `openQuestions` used to be
 * overwritten by each reflection's follow-ups, so of up to five planned
 * questions only the first was ever pursued and the rest vanished without trace.
 * A ledger makes the investigation inspectable: every question keeps its
 * identity, its attempts, and the claims that answered it.
 *
 * Status transitions are DETERMINISTIC. No model asserts that its own question
 * was answered - that is the judgment most likely to be wrong and least likely
 * to be checked.
 */
export class QuestionLedger {
  private readonly records: ResearchQuestionRecord[] = [];
  private ordinal = 0;

  constructor(private readonly sectionKey: string) {}

  /**
   * Append questions, deduped on normalized text.
   *
   * Returns only those actually added. A reflection re-proposing a question
   * already in the ledger must not reset its attempts or revive an exhausted
   * one, or a specialist could loop on the same unanswerable question forever.
   */
  add(questions: readonly { question: string; concept: string }[], origin: 'planned' | 'followup'): ResearchQuestionRecord[] {
    const added: ResearchQuestionRecord[] = [];
    for (const q of questions) {
      const key = normalize(q.question);
      if (!key) continue;
      if (this.records.some((r) => normalize(r.question) === key)) continue;
      const record: ResearchQuestionRecord = {
        id: `${this.sectionKey}#q${++this.ordinal}`,
        question: q.question,
        concept: q.concept,
        origin,
        status: 'open',
        attempts: 0,
        unusableAttempts: 0,
        answeringClaimIds: [],
        retrievalAuditIds: [],
      };
      this.records.push(record);
      added.push(record);
    }
    return added;
  }

  /** Highest-priority open question, in insertion order. Planned questions therefore outlive round 0. */
  next(): ResearchQuestionRecord | undefined {
    const found = this.records.find((r) => r.status === 'open');
    // A copy: callers hold this across a whole round, and handing out the live
    // record would let any of them bypass every invariant in this class.
    return found ? { ...found } : undefined;
  }

  /**
   * Record one attempt at a question.
   *
   * `usableRetrieval` counts toward exhaustion; drafting claims that fail to
   * ground does not, because that is a claim-quality problem rather than
   * evidence being absent, and it is already caught by grounding.
   */
  recordAttempt(id: string, opts: {
    claimIds: readonly string[];
    retrievalAuditIds: readonly string[];
    usableRetrieval: boolean;
    round: number;
  }): void {
    const record = this.records.find((r) => r.id === id);
    // Unknown id is a bookkeeping defect in the caller, not a recoverable
    // state. Silently ignoring it would let a whole round's work go unrecorded.
    if (!record) throw new Error(`QuestionLedger: unknown question id ${id}`);
    record.attempts += 1;
    if (!opts.usableRetrieval) record.unusableAttempts += 1;
    if (record.firstAskedRound === undefined) record.firstAskedRound = opts.round;
    record.answeringClaimIds = [...new Set([...record.answeringClaimIds, ...opts.claimIds])];
    record.retrievalAuditIds = [...new Set([...record.retrievalAuditIds, ...opts.retrievalAuditIds])];

    // Bounded by ATTEMPTS, not by whether retrieval was usable. An earlier
    // version exhausted only on unusable retrieval, which let a question with
    // usable retrieval whose claims never ground stay open forever - `next()`
    // kept returning it and one stubborn question could consume the entire
    // round budget, which is the failure this ledger exists to fix.
    // `unusableAttempts` records WHY it failed without changing WHETHER it stops.
    if (record.status === 'open' && record.attempts >= MAX_ATTEMPTS_PER_QUESTION) {
      record.status = 'unanswered_exhausted';
    }
  }

  /**
   * Sufficiency, primary and deterministic: a question with at least one
   * grounded answering claim is answered.
   *
   * Also revives an exhausted question that turns out to have a grounded claim -
   * exhaustion is a statement about retrieval, and evidence outranks it.
   */
  applyGrounding(groundedClaimIds: ReadonlySet<string>): void {
    for (const record of this.records) {
      const grounded = record.answeringClaimIds.filter((id) => groundedClaimIds.has(id));
      if (grounded.length > 0) record.status = 'answered';
    }
  }

  /**
   * Reconcile after verification.
   *
   * `runResearcher` can only test grounding, because verification runs later in
   * `produceResearchSection`. A question marked answered on claims the verifier
   * then rejected returns to `open`: treating rejected evidence as an answer is
   * the same defect as a conclusion resting on rejected claims.
   */
  applyVerification(supportedClaimIds: ReadonlySet<string>): void {
    for (const record of this.records) {
      if (record.status !== 'answered') continue;
      const surviving = record.answeringClaimIds.filter((id) => supportedClaimIds.has(id));
      if (surviving.length === 0) record.status = 'open';
    }
  }

  all(): ResearchQuestionRecord[] {
    return this.records.map((r) => ({ ...r }));
  }

  open(): ResearchQuestionRecord[] {
    return this.all().filter((r) => r.status === 'open');
  }

  /** Everything the dossier must name rather than drop. */
  unanswered(): ResearchQuestionRecord[] {
    return this.all().filter((r) => r.status === 'open' || r.status === 'unanswered_exhausted');
  }
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase().replace(/[?.!]+$/, '');
}
