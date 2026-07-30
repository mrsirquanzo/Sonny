import { z } from 'zod';

/**
 * Status of one research question a specialist set itself.
 *
 * `unanswered_exhausted` is a FINDING, not a failure. "The literature does not
 * answer this" is information a reader needs, and it is exactly what retrieval
 * audits exist to substantiate. Silently dropping such a question makes a
 * truncated investigation read as a complete one.
 */
export const QuestionStatusSchema = z.enum(['open', 'answered', 'unanswered_exhausted']);
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;

export const ResearchQuestionRecordSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  concept: z.string().min(1),
  origin: z.enum(['planned', 'followup']),
  status: QuestionStatusSchema,
  attempts: z.number().int().nonnegative(),
  /** Attempts where retrieval returned nothing usable. Distinguishes "the
   *  literature does not cover this" from "we retrieved evidence but no claim
   *  survived", which are different findings for a reader. */
  unusableAttempts: z.number().int().nonnegative(),
  answeringClaimIds: z.array(z.string()),
  retrievalAuditIds: z.array(z.string()),
  firstAskedRound: z.number().int().nonnegative().optional(),
});
export type ResearchQuestionRecord = z.infer<typeof ResearchQuestionRecordSchema>;

/**
 * Attempts allowed on one question before it is recorded as unanswerable.
 *
 * Bounded so a specialist cannot spend its whole budget re-asking one question
 * that the sources cannot answer, while still distinguishing a single unlucky
 * search from a genuine absence.
 */
export const MAX_ATTEMPTS_PER_QUESTION = 2;
