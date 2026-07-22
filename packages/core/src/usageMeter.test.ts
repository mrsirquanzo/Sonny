import { describe, it, expect } from 'vitest';
import { costFor, PRICE_PER_MTOK } from './pricing.js';
import { createUsageMeter } from './usageMeter.js';

describe('costFor', () => {
  it('prices a known model per million tokens', () => {
    const p = PRICE_PER_MTOK['claude-sonnet-4-5'];
    expect(costFor('claude-sonnet-4-5', 1_000_000, 1_000_000)).toBeCloseTo(p.in + p.out, 6);
  });

  it('returns undefined for an unknown model (never 0)', () => {
    expect(costFor('some/unlisted-model', 1000, 1000)).toBeUndefined();
  });

  it('treats locally hosted models as free', () => {
    expect(costFor('ollama/llama3', 1_000_000, 1_000_000)).toBe(0);
    expect(costFor('local/whatever', 5000, 5000)).toBe(0);
  });
});

describe('createUsageMeter', () => {
  it('aggregates tokens and calls per model and totals a known-price run', () => {
    const meter = createUsageMeter();
    meter.record('claude-sonnet-4-5', { tokensIn: 1_000_000, tokensOut: 0 });
    meter.record('claude-sonnet-4-5', { tokensIn: 0, tokensOut: 1_000_000 });
    const snap = meter.snapshot(Date.now());
    expect(snap.calls).toBe(2);
    expect(snap.models).toHaveLength(1);
    expect(snap.models[0]).toMatchObject({ model: 'claude-sonnet-4-5', calls: 2, tokensIn: 1_000_000, tokensOut: 1_000_000 });
    expect(snap.pricingKnown).toBe(true);
    const p = PRICE_PER_MTOK['claude-sonnet-4-5'];
    expect(snap.totals.costUsd).toBeCloseTo(p.in + p.out, 6);
  });

  it('reports pricingKnown=false and no total cost when any model has an unknown price', () => {
    const meter = createUsageMeter();
    meter.record('claude-sonnet-4-5', { tokensIn: 100, tokensOut: 100 });
    meter.record('some/unlisted-model', { tokensIn: 100, tokensOut: 100 });
    const snap = meter.snapshot(Date.now());
    expect(snap.pricingKnown).toBe(false);
    expect(snap.totals.costUsd).toBeUndefined();
    expect(snap.totals.tokensIn).toBe(200);
    expect(snap.totals.tokensOut).toBe(200);
  });
});
