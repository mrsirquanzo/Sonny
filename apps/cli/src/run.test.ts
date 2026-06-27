import { describe, it, expect } from 'vitest';
import type { TraceEvent } from '@sonny/shared';
import { formatTrace } from './run.js';

describe('formatTrace', () => {
  it('renders plan, evidence, and verdict lines', () => {
    const events: TraceEvent[] = [
      { type: 'plan', specialists: ['target_biology'], tools: ['open_targets_search'] },
      { type: 'evidence_registered', id: 'ENSG00000146648', title: 'EGFR' },
      { type: 'verdict', verdict: { claimId: 'c1', status: 'supported', rationale: 'r' } },
    ];
    const out = formatTrace(events);
    expect(out).toContain('PLAN');
    expect(out).toContain('ENSG00000146648');
    expect(out).toContain('supported');
  });
});
