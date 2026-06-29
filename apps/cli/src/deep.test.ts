import { describe, it, expect } from 'vitest';
import type { TraceEvent } from '@sonny/shared';
import { formatTrace } from './run.js';

describe('formatTrace research events', () => {
  it('renders research plan, read, and reflect lines', () => {
    const events: TraceEvent[] = [
      { type: 'research_plan', specialist: 'target_biology', questions: ['What is the MOA of CDCP1?'] },
      { type: 'research_read', specialist: 'target_biology', sourceId: 'PMCID:PMC1#sec-1', locator: 'Results' },
      { type: 'research_reflect', specialist: 'target_biology', note: 'EMT driver', followups: ['check resistance'] },
    ];
    const out = formatTrace(events);
    expect(out).toContain('What is the MOA of CDCP1?');
    expect(out).toContain('reading PMCID:PMC1#sec-1');
    expect(out).toContain('Results');
    expect(out).toContain('check resistance');
  });
});
