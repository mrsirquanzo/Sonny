import { describe, it, expect } from 'vitest';
import type { TraceEvent, Briefing } from './contracts.js';
import { ClaimSchema, ClaimsSchema, EvidenceSchema, VerdictSchema, RecommendationSchema, ReferenceSchema } from './contracts.js';

describe('contracts', () => {
  it('accepts a valid evidence record', () => {
    const e = { id: 'ENSG00000146648', kind: 'target', source: 'Open Targets',
      title: 'EGFR', snippet: 'receptor tyrosine kinase', url: 'https://x', raw: {}, retrievedAt: '2026-06-27T00:00:00Z' };
    expect(EvidenceSchema.parse(e).id).toBe('ENSG00000146648');
  });

  it('rejects a claim with no citations array', () => {
    expect(() => ClaimSchema.parse({ id: 'c1', text: 'x', confidence: 0.5 })).toThrow();
  });

  it('parses a claims envelope', () => {
    const parsed = ClaimsSchema.parse({ claims: [{ id: 'c1', text: 'x', citations: ['PMID:1'], confidence: 0.9 }] });
    expect(parsed.claims).toHaveLength(1);
  });

  it('constrains verdict status', () => {
    expect(() => VerdictSchema.parse({ claimId: 'c1', status: 'maybe', rationale: 'r' })).toThrow();
  });
});

describe('research trace events', () => {
  it('accepts research_plan, research_read, research_reflect', () => {
    const events: TraceEvent[] = [
      { type: 'research_plan', specialist: 'target_biology', questions: ['what is the MOA?'] },
      { type: 'research_read', specialist: 'target_biology', sourceId: 'PMCID:PMC1#sec-0', locator: 'Results' },
      { type: 'research_reflect', specialist: 'target_biology', note: 'genetics weak vs literature', followups: ['check resistance'] },
    ];
    expect(events.map((e) => e.type)).toEqual(['research_plan', 'research_read', 'research_reflect']);
  });
});

describe('lead trace events', () => {
  it('accepts lead_decompose, completeness_verdict, gap_filler', () => {
    const events: TraceEvent[] = [
      { type: 'lead_decompose', specialists: ['target_biology', 'moa_pathway'] },
      { type: 'completeness_verdict', complete: false, gaps: ['resistance mechanisms'] },
      { type: 'gap_filler', specialist: 'clinical_landscape', question: 'What are the acquired resistance mechanisms?' },
    ];
    expect(events.map((e) => e.type)).toEqual(['lead_decompose', 'completeness_verdict', 'gap_filler']);
  });
});

describe('briefing contracts', () => {
  it('parses a recommendation and accepts the recommendation trace event', () => {
    const rec = RecommendationSchema.parse({
      verdict: 'watch', thesis: 'Interesting but under-validated.',
      bull: [{ point: 'Tractable surface antigen.', citations: ['ENSG1'] }],
      bear: [{ point: 'Weak human genetics.', citations: ['ENSG1'] }],
      conditions: ['A positive Phase 1 readout would move this to GO.'],
    });
    expect(rec.verdict).toBe('watch');
    const ref = ReferenceSchema.parse({ id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'X', url: 'u' });
    expect(ref.id).toBe('PMID:1');
    const ev: TraceEvent = { type: 'recommendation', verdict: 'watch' };
    expect(ev.type).toBe('recommendation');
    const briefing: Briefing = {
      target: 'CDCP1', recommendation: rec, executiveRead: 'read',
      sections: [], weighing: { takeaway: '', claims: [] }, references: [ref],
    };
    expect(briefing.references).toHaveLength(1);
  });

  it('rejects an invalid verdict', () => {
    expect(() => RecommendationSchema.parse({
      verdict: 'maybe', thesis: 't', bull: [], bear: [], conditions: [],
    })).toThrow();
  });
});
