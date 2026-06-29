import { describe, it, expect } from 'vitest';
import type { TraceEvent } from '@sonny/shared';
import { formatTrace } from './run.js';
import { currentBackend } from '@sonny/core';

describe('deep backend default', () => {
  it('defaults to the local ollama backend when SONNY_BACKEND is unset', () => {
    const saved = process.env.SONNY_BACKEND;
    delete process.env.SONNY_BACKEND;
    expect(currentBackend()).toBe('ollama');
    if (saved !== undefined) process.env.SONNY_BACKEND = saved;
  });
});

describe('formatTrace recommendation event', () => {
  it('renders the recommendation verdict line', () => {
    const events: TraceEvent[] = [{ type: 'recommendation', verdict: 'watch' }];
    const out = formatTrace(events);
    expect(out.toLowerCase()).toContain('recommendation');
    expect(out).toContain('watch');
  });
});

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

describe('formatTrace lead events', () => {
  it('renders decompose, completeness, and gap-filler lines', () => {
    const events: TraceEvent[] = [
      { type: 'lead_decompose', specialists: ['target_biology', 'moa_pathway'] },
      { type: 'completeness_verdict', complete: false, gaps: ['resistance mechanisms'] },
      { type: 'gap_filler', specialist: 'moa_pathway', question: 'How does resistance arise?' },
    ];
    const out = formatTrace(events);
    expect(out).toContain('target_biology');
    expect(out).toContain('gap');
    expect(out).toContain('resistance mechanisms');
    expect(out).toContain('How does resistance arise?');
  });
});
