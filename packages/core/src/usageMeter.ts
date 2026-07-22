import type { RunMeta } from '@mrsirquanzo/sonny-shared';
import { costFor } from './pricing.js';
import { currentBackend } from './model.js';

export interface UsageMeter {
  record(model: string, u: { tokensIn: number; tokensOut: number }): void;
  snapshot(startedAt: number): RunMeta;
}

/**
 * Accumulates per-model token usage across a run. Cost is only claimed when
 * EVERY model that logged calls has a known price - otherwise `pricingKnown`
 * is false and the totals carry no USD figure.
 */
export function createUsageMeter(): UsageMeter {
  const byModel = new Map<string, { calls: number; tokensIn: number; tokensOut: number }>();

  return {
    record(model, u) {
      const entry = byModel.get(model) ?? { calls: 0, tokensIn: 0, tokensOut: 0 };
      entry.calls += 1;
      entry.tokensIn += u.tokensIn;
      entry.tokensOut += u.tokensOut;
      byModel.set(model, entry);
    },
    snapshot(startedAt) {
      const completedAt = Date.now();
      const models = [...byModel.entries()].map(([model, e]) => ({
        model, calls: e.calls, tokensIn: e.tokensIn, tokensOut: e.tokensOut,
        costUsd: costFor(model, e.tokensIn, e.tokensOut),
      }));
      const pricingKnown = models.every((m) => m.costUsd !== undefined);
      return {
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date(completedAt).toISOString(),
        durationMs: completedAt - startedAt,
        backend: currentBackend(),
        calls: models.reduce((n, m) => n + m.calls, 0),
        models,
        totals: {
          tokensIn: models.reduce((n, m) => n + m.tokensIn, 0),
          tokensOut: models.reduce((n, m) => n + m.tokensOut, 0),
          costUsd: pricingKnown ? models.reduce((n, m) => n + (m.costUsd ?? 0), 0) : undefined,
        },
        pricingKnown,
      };
    },
  };
}
