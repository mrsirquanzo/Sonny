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

  it('reports that an empty regression list came from a missing baseline, not from measurement', async () => {
    const missing = await checkRegression(card([target('a', 1, 0.95)]), '/nonexistent/_baseline.json');
    expect(missing.baselineFound).toBe(false);

    const path = await import('node:path');
    const os = await import('node:os');
    const fs = (await import('node:fs')).promises;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sonny-eval-baseline-'));
    const file = path.join(dir, '_baseline.json');
    await fs.writeFile(file, JSON.stringify(card([target('a', 1, 0.95)])), 'utf8');
    try {
      const found = await checkRegression(card([target('a', 1, 0.95)]), file);
      expect(found.baselineFound).toBe(true);
      expect(found.regressed).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('detects a real regression once a baseline exists', async () => {
    const path = await import('node:path');
    const os = await import('node:os');
    const fs = (await import('node:fs')).promises;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sonny-eval-baseline-'));
    const file = path.join(dir, '_baseline.json');
    await fs.writeFile(file, JSON.stringify(card([target('a', 1, 1.0)])), 'utf8');
    try {
      // faithfulness 1.0 -> 0.5, well past its 0.03 tolerance.
      const reg = await checkRegression(card([target('a', 1, 0.5)]), file);
      expect(reg.baselineFound).toBe(true);
      expect(reg.regressed).toContainEqual({
        metric: 'faithfulness', baseline: 1, current: 0.5, tolerance: 0.03,
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('hard-fails when grounding_integrity fails on any target', async () => {
    const reg = await checkRegression(card([target('a', 0.5, 0.95)]), '/nonexistent/_baseline.json');
    expect(reg.hardFailures).toContain('a');
  });

  it('hard-fails mandatory computation grounding independently of a baseline', async () => {
    const score = target('a', 1, 0.95);
    score.metrics.push({ name: 'computation_grounding', score: 0, pass: false });
    const reg = await checkRegression(card([score]), '/nonexistent/_baseline.json');
    expect(reg.hardFailures).toContain('a');
    expect(reg.belowFloor).toContainEqual({ metric: 'computation_grounding', floor: 1, current: 0 });
  });
});
