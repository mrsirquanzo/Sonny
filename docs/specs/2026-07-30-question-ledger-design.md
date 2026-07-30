# Digging: question ledger and evidence-grounded termination

Status: design, 2026-07-30.
Supersedes the next-slice ordering in `docs/slices/STATUS.md`.

## Why this and not slices 6-8

Slices 6, 7 and 8 (asset registry, multi-variant fan-out, nomination and
bake-off) all serve **choosing** a modality.
The priority is **digging**: specialists that ask sharper questions until the
evidence answers them.
Those slices are deferred, not cancelled.

## What already works

`runResearcher` plans questions, pursues them, reflects on the claims it
produced, and generates follow-ups.
The skeleton is right.

## What is broken

1. **Four of five planned questions are discarded.**
   `planResearchQuestions` returns up to 5, most important first.
   Each round pursues `openQuestions[0]`, then `openQuestions = reflection.followups`
   replaces the entire queue.
   Questions 2-5 are never asked.

2. **One question per round against `maxRounds`, which the eval sets to 4.**
   A specialist asks at most four questions in its lifetime.

3. **Termination is self-reported against the wrong evidence.**
   `reflectOnGaps` sees the objective and the text of claims so far.
   It does not see the question being pursued, how many relevant hits retrieval
   returned, or whether that question produced any claim.
   A specialist whose search returned nothing can declare `done: true`.

4. **There is no ledger.**
   Because the queue is replaced wholesale, nothing records what was asked,
   what was answered, and what remains open.

5. **Questions cannot cross specialists.** Out of scope here.

## The contract

```ts
export const QuestionStatusSchema = z.enum([
  'open',                  // asked or queued, not yet answered
  'answered',              // has at least one surviving claim
  'unanswered_exhausted',  // retrieval repeatedly returned nothing usable
]);

export const ResearchQuestionRecordSchema = z.object({
  id: z.string().min(1),                 // `${sectionKey}#q${ordinal}`
  question: z.string().min(1),
  concept: z.string().min(1),
  origin: z.enum(['planned', 'followup']),
  status: QuestionStatusSchema,
  attempts: z.number().int().nonnegative(),
  answeringClaimIds: z.array(z.string()),
  retrievalAuditIds: z.array(z.string()),
  firstAskedRound: z.number().int().nonnegative().optional(),
});
```

## Termination

**[NORMATIVE] Sufficiency is primary and deterministic.**
A question is `answered` when at least one claim drafted while pursuing it
grounds - every citation resolves in the `EvidenceStore`.
No model asserts that its own question was answered.

**[NORMATIVE] Sufficiency is re-evaluated after verification.**
`runResearcher` can only test grounding, because verification runs afterwards in
`produceResearchSection`.
A question whose answering claims ALL fail verification returns to `open`.
Marking a question answered on evidence the verifier later rejects is the same
defect class as a conclusion resting on rejected claims.

**[NORMATIVE] Exhaustion is secondary and bounded.**
A question reaching `MAX_ATTEMPTS_PER_QUESTION` attempts with no usable
retrieval becomes `unanswered_exhausted` and is not retried.
This is a real finding, not a failure: "the literature does not answer this" is
information, and it is what retrieval audits exist to substantiate.

**[NORMATIVE] The queue merges; it never replaces.**
Follow-ups append. Planned questions survive until answered or exhausted.
Deduplicated on normalized question text so a reflection cannot re-add what is
already in the ledger.

## Shipping with named open questions

**[NORMATIVE]** A section carries its full ledger.
A dossier MAY ship with `open` and `unanswered_exhausted` questions, and they
MUST be named on the artifact rather than dropped.
A silently truncated investigation reads as a complete one; an explicit "asked,
could not answer" is honest and actionable.

## Out of scope

Cross-specialist question routing. Raising `maxRounds` as a substitute for
better termination. Any change to modality resolution.
