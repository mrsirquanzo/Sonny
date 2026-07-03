import { describe, it, expect } from 'vitest';
import type { TraceEvent, Briefing } from './contracts.js';
import { ClaimSchema, ClaimsSchema, EvidenceSchema, VerdictSchema, RecommendationSchema, ReferenceSchema, MethodologicalCritiqueSchema, RedFlagSchema, SectionSchema, DevelopabilityRiskSchema, VerdictLabelSchema } from './contracts.js';

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

describe('abstention verdict', () => {
  it("accepts 'insufficient-evidence' as a verdict label", () => {
    expect(VerdictLabelSchema.parse('insufficient-evidence')).toBe('insufficient-evidence');
  });

  it('RecommendationSchema accepts an abstention recommendation', () => {
    const r = RecommendationSchema.parse({
      verdict: 'insufficient-evidence', thesis: 'Insufficient verified evidence.',
      bull: [], bear: [], conditions: [],
    });
    expect(r.verdict).toBe('insufficient-evidence');
  });
});

describe('MethodologicalCritique schema', () => {
  const valid = {
    evidenceId: 'PMID:1',
    studyDesign: 'single_arm',
    sampleSize: 42,
    redFlags: [{ category: 'surrogate_endpoint', biasRisk: 'high', explanation: 'eGFR is a surrogate.' }],
  };

  it('accepts a valid critique', () => {
    expect(MethodologicalCritiqueSchema.parse(valid)).toEqual(valid);
  });

  it('accepts null sampleSize', () => {
    expect(MethodologicalCritiqueSchema.parse({ ...valid, sampleSize: null }).sampleSize).toBeNull();
  });

  it('rejects an invalid studyDesign', () => {
    expect(() => MethodologicalCritiqueSchema.parse({ ...valid, studyDesign: 'meta_analysis' })).toThrow();
  });

  it('rejects an invalid biasRisk tier (no fatal/red/amber)', () => {
    expect(() => RedFlagSchema.parse({ category: 'unblinded', biasRisk: 'fatal', explanation: 'x' })).toThrow();
    expect(() => RedFlagSchema.parse({ category: 'unblinded', biasRisk: 'red', explanation: 'x' })).toThrow();
  });

  it('rejects an invalid red-flag category', () => {
    expect(() => RedFlagSchema.parse({ category: 'small_n', biasRisk: 'low', explanation: 'x' })).toThrow();
  });

  it('rejects an empty explanation', () => {
    expect(() => RedFlagSchema.parse({ category: 'unblinded', biasRisk: 'low', explanation: '' })).toThrow();
  });
});

describe('Claim and Section carry optional audit data', () => {
  it('Claim accepts optional redFlags', () => {
    const c = { id: 'c1', text: 't', citations: ['PMID:1'], confidence: 0.8,
      redFlags: [{ category: 'high_dropout', biasRisk: 'moderate', explanation: '30% dropout.' }] };
    expect(ClaimSchema.parse(c).redFlags?.[0].category).toBe('high_dropout');
  });

  it('Claim is valid without redFlags', () => {
    expect(ClaimSchema.parse({ id: 'c1', text: 't', citations: [], confidence: 0.5 }).redFlags).toBeUndefined();
  });

  it('Section accepts optional critiques', () => {
    const s = { id: 'a', title: 'A', takeaway: 't', claims: [], sources: [], rag: 'green',
      critiques: [{ evidenceId: 'PMID:1', studyDesign: 'in_vitro', sampleSize: null, redFlags: [] }] };
    expect(SectionSchema.parse(s).critiques?.[0].studyDesign).toBe('in_vitro');
  });
});

describe('DevelopabilityRisk schema', () => {
  const valid = { evidenceId: 'PMID:9', category: 'immunogenicity', severity: 'severe', explanation: 'High ADA incidence.' };

  it('accepts a valid developability risk', () => {
    expect(DevelopabilityRiskSchema.parse(valid)).toEqual(valid);
  });

  it('rejects an invalid severity (no fatal/blocker)', () => {
    expect(() => DevelopabilityRiskSchema.parse({ ...valid, severity: 'fatal' })).toThrow();
    expect(() => DevelopabilityRiskSchema.parse({ ...valid, severity: 'blocker' })).toThrow();
  });

  it('rejects an invalid category', () => {
    expect(() => DevelopabilityRiskSchema.parse({ ...valid, category: 'potency' })).toThrow();
  });

  it('rejects an empty explanation', () => {
    expect(() => DevelopabilityRiskSchema.parse({ ...valid, explanation: '' })).toThrow();
  });

  it('Section accepts optional developabilityRisks', () => {
    const s = { id: 'm', title: 'M', takeaway: 't', claims: [], sources: [], rag: 'red',
      developabilityRisks: [valid] };
    expect(SectionSchema.parse(s).developabilityRisks?.[0].severity).toBe('severe');
  });
});

import { EvidenceMetadataSchema, KOLClusterSchema } from './contracts.js';

describe('ClaimSchema confidence', () => {
  it('clamps a confidence above 1 to 1', () => {
    const c = ClaimSchema.parse({ id: 'c1', text: 't', citations: ['PMID:1'], confidence: 1.7 });
    expect(c.confidence).toBe(1);
  });
  it('clamps a negative confidence to 0', () => {
    const c = ClaimSchema.parse({ id: 'c1', text: 't', citations: ['PMID:1'], confidence: -0.5 });
    expect(c.confidence).toBe(0);
  });
  it('still rejects a non-numeric confidence', () => {
    expect(() => ClaimSchema.parse({ id: 'c1', text: 't', citations: ['PMID:1'], confidence: 'high' as unknown as number })).toThrow();
  });
});

describe('Evidence metadata and KOLCluster schemas', () => {
  it('Evidence accepts optional metadata with authors and institutions', () => {
    const e = { id: 'PMID:1', kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now',
      metadata: { authors: [{ name: 'Smith J', affiliation: 'MIT', orcid: '0000-0001' }], institutions: ['MIT'] } };
    expect(EvidenceSchema.parse(e).metadata?.authors?.[0].name).toBe('Smith J');
  });

  it('Evidence is valid without metadata', () => {
    expect(EvidenceSchema.parse({ id: 'PMID:1', kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' }).metadata).toBeUndefined();
  });

  it('an author requires a name', () => {
    expect(() => EvidenceMetadataSchema.parse({ authors: [{ affiliation: 'x' }] })).toThrow();
  });

  it('KOLCluster validates labs', () => {
    const c = { target: 'CDCP1', labs: [{ investigator: 'Smith J', institution: 'MIT', paperCount: 3, weight: 9, evidenceIds: ['PMID:1'] }] };
    expect(KOLClusterSchema.parse(c).labs[0].investigator).toBe('Smith J');
  });

  it('KOLCluster rejects a non-integer paperCount', () => {
    expect(() => KOLClusterSchema.parse({ target: 't', labs: [{ investigator: 'x', paperCount: 1.5, weight: 1, evidenceIds: [] }] })).toThrow();
  });
});

import {
  EvidenceKindSchema, FigureReadingSchema, FiguresAnalyzeResponseSchema,
} from './contracts.js';

describe('figure contracts', () => {
  it("accepts 'figure' as an Evidence kind", () => {
    expect(EvidenceKindSchema.parse('figure')).toBe('figure');
  });

  it('validates a FigureReading with binary readRisk', () => {
    const r = FigureReadingSchema.parse({
      evidenceId: 'PMCID:PMC1#fig-0',
      figureType: 'forest_plot',
      reading: 'Pooled HR 0.62.',
      extractedValues: [{ label: 'HR', value: '0.62', inCaption: true, readRisk: 'low' }],
      confidence: 0.8,
    });
    expect(r.extractedValues[0].readRisk).toBe('low');
  });

  it('rejects readRisk="moderate" (no moderate tier this slice)', () => {
    expect(() => FigureReadingSchema.parse({
      evidenceId: 'x', reading: 'r', confidence: 0.5,
      extractedValues: [{ label: 'HR', value: '1', inCaption: false, readRisk: 'moderate' }],
    })).toThrow();
  });

  it('parses a sidecar wire response that omits inCaption/readRisk', () => {
    const w = FiguresAnalyzeResponseSchema.parse({
      readings: [{
        figureId: 'PMCID:PMC1#fig-0', relevanceScore: 0.9, figureType: 'bar',
        reading: 'r', extractedValues: [{ label: 'x', value: '1' }], confidence: 0.7,
      }],
    });
    expect(w.readings[0].extractedValues[0]).not.toHaveProperty('readRisk');
  });
});
