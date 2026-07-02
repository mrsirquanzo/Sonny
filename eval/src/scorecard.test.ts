import { describe, it, expect } from 'vitest';
import { aggregate, checkRegression, type Scorecard, type TargetScore } from './scorecard.js';

function target(name: string, grounding: number, faithful: number): TargetScore {
  return {
    target: name, label: 'watch', verdict: 'watch', trap: false,
    metrics: [
      { name: 'grounding_integrity', score: grounding, pass: grounding >= 0.99 },
      { name: 'faithfulness', score: faithful, pass: faithful >= 0.9 },
    ],
  };
}

function card(targets: TargetScore[]): Scorecard {
  return { runAt: '2026-07-02', backend: 'anthropic', subset: 'fast', targets, aggregates: aggregate(targets) };
}

describe('scorecard', () => {
  it('aggregates per-metric means', () => {
    const agg = aggregate([target('a', 1, 0.8), target('b', 1, 1.0)]);
    expect(agg.grounding_integrity).toBe(1);
    expect(agg.faithfulness).toBeCloseTo(0.9, 5);
  });

  it('treats a missing baseline as a first run (no regressions)', async () => {
    const reg = await checkRegression(card([target('a', 1, 0.95)]), '/nonexistent/_baseline.json');
    expect(reg.regressed).toEqual([]);
    expect(reg.hardFailures).toEqual([]);
  });

  it('hard-fails when grounding_integrity fails on any target', async () => {
    const reg = await checkRegression(card([target('a', 0.5, 0.95)]), '/nonexistent/_baseline.json');
    expect(reg.hardFailures).toContain('a');
  });
});
