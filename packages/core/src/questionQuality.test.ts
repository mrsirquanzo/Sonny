import { describe, expect, it } from 'vitest';
import type { StructuredModel } from './model.js';
import { planResearchQuestions, reflectOnGaps } from './researcher.js';

const brief = {
  id: 'target_biology', title: 'Target Biology',
  objective: 'Assess the target.', promptHint: 'Be rigorous.',
};

function capture(): { model: StructuredModel; seen: { system: string; prompt: string }[] } {
  const seen: { system: string; prompt: string }[] = [];
  return {
    seen,
    model: {
      async generateStructured(opts) {
        seen.push({ system: String(opts.system), prompt: String(opts.prompt) });
        return { questions: [], done: true, followups: [], takeaway: '' } as never;
      },
    },
  };
}

describe('planResearchQuestions asks for decision-relevant questions', () => {
  it('demands discriminating questions rather than survey questions', async () => {
    const { model, seen } = capture();
    await planResearchQuestions(brief, 'CDCP1', model);
    expect(seen[0].system).toMatch(/DECISION-RELEVANT and DISCRIMINATING/);
    // The concrete contrast matters more than the adjectives: it names the
    // failure mode, a question that cannot come back negative.
    expect(seen[0].system).toMatch(/cannot come back negative/);
    expect(seen[0].system).toMatch(/literature can actually settle/);
  });

  // Curated cards are seeded before specialists run. A question the cards
  // already answer spends a whole round re-deriving a fact Sonny holds.
  it('shows the planner what the curated databases already answer', async () => {
    const { model, seen } = capture();
    await planResearchQuestions(brief, 'CDCP1', model, undefined, [
      'Subcellular location: Cell membrane.',
      'Baseline expression across 25 normal biosamples.',
    ]);
    expect(seen[0].prompt).toContain('ALREADY KNOWN');
    expect(seen[0].prompt).toContain('Subcellular location: Cell membrane.');
    expect(seen[0].system).toMatch(/Do NOT ask what the ALREADY KNOWN facts below already answer/);
  });

  it('omits the known-facts block entirely when nothing is seeded', async () => {
    const { model, seen } = capture();
    await planResearchQuestions(brief, 'CDCP1', model);
    expect(seen[0].prompt).not.toContain('ALREADY KNOWN');
  });
});

describe('reflectOnGaps attacks the weakest finding', () => {
  it('asks for follow-ups targeting the weakest part, not restatements', async () => {
    const { model, seen } = capture();
    await reflectOnGaps(brief, [], model);
    expect(seen[0].system).toMatch(/WEAKEST part/);
    expect(seen[0].system).toMatch(/resting on one source/);
    expect(seen[0].system).toMatch(/merely restates a claim you already hold adds nothing/);
    // `done` is no longer a progress report; it is a claim that nothing left
    // would change the answer.
    expect(seen[0].system).toMatch(/done=true only when the remaining questions would not change the assessment/);
  });

  it('sees the question it just pursued', async () => {
    const { model, seen } = capture();
    await reflectOnGaps(brief, [], model, undefined, 'Is the target internalized?');
    expect(seen[0].prompt).toContain('QUESTION JUST PURSUED: Is the target internalized?');
  });

  // The ledger dedups duplicates anyway, so proposing them silently wastes the
  // three follow-up slots this call gets.
  it('is told what is already queued so it does not spend slots on duplicates', async () => {
    const { model, seen } = capture();
    await reflectOnGaps(brief, [], model, undefined, 'pursued?', ['Still open one?', 'Still open two?']);
    expect(seen[0].prompt).toContain('ALREADY QUEUED');
    expect(seen[0].prompt).toContain('Still open one?');
  });

  it('omits the queued block when nothing else is open', async () => {
    const { model, seen } = capture();
    await reflectOnGaps(brief, [], model);
    expect(seen[0].prompt).not.toContain('ALREADY QUEUED');
  });
});
