import { describe, it, expect } from 'vitest';
import type { Section, TraceEvent } from '@mrsirquanzo/sonny-shared';
import { formatTrace } from './run.js';

describe('formatTrace', () => {
  it('renders plan, evidence, and verdict lines', () => {
    const events: TraceEvent[] = [
      { type: 'plan', specialists: ['target_biology'], tools: ['open_targets_target'] },
      { type: 'evidence_registered', id: 'ENSG00000146648', title: 'EGFR' },
      { type: 'verdict', verdict: { claimId: 'c1', status: 'supported', rationale: 'r' } },
    ];
    const out = formatTrace(events);
    expect(out).toContain('PLAN');
    expect(out).toContain('ENSG00000146648');
    expect(out).toContain('supported');
  });

  it('renders skipped specialists and completed sections with RAG + takeaway + cited claims', () => {
    const section: Section = {
      id: 'target_biology', title: 'Target Biology', takeaway: 'EGFR is a tractable kinase.',
      claims: [{ id: 'c1', text: 'EGFR is a receptor tyrosine kinase.', citations: ['ENSG00000146648'], confidence: 0.95 }],
      sources: ['ENSG00000146648'], rag: 'green',
    };
    const events: TraceEvent[] = [
      { type: 'specialist_start', specialist: 'target_biology' },
      { type: 'specialist_skipped', specialist: 'safety_tox', reason: 'no safety question' },
      { type: 'section_complete', section },
    ];
    const out = formatTrace(events);
    expect(out).toContain('Target Biology');
    expect(out).toContain('[GREEN]');
    expect(out).toContain('EGFR is a tractable kinase.');
    expect(out).toContain('[ENSG00000146648]');
    expect(out).toContain('skipped safety_tox');
  });
});
