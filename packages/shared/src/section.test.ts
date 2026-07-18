import { describe, it, expect } from 'vitest';
import { SectionSchema, RagRatingSchema, EvidenceKindSchema, migrateSectionsToV1 } from './contracts.js';

describe('section contracts', () => {
  it('parses a valid section', () => {
    const s = { kind: 'research', id: 'target_biology', title: 'Target Biology', takeaway: 'EGFR is tractable.',
      claims: [{ id: 'c1', text: 'x', citations: ['ENSG00000146648'], confidence: 0.9 }],
      sources: ['ENSG00000146648'], rag: 'green' };
    expect(SectionSchema.parse(s).id).toBe('target_biology');
  });
  it('constrains rag to the three ratings', () => {
    expect(() => RagRatingSchema.parse('blue')).toThrow();
    expect(RagRatingSchema.parse('amber')).toBe('amber');
  });
  it('accepts the new disease and drug evidence kinds', () => {
    expect(EvidenceKindSchema.parse('disease')).toBe('disease');
    expect(EvidenceKindSchema.parse('drug')).toBe('drug');
  });

  it('migrates legacy sections to research while preserving explicit analysis sections', () => {
    const legacy = { id: 'old', title: 'Old', takeaway: '', claims: [], sources: [], rag: 'red' };
    const analysis = {
      kind: 'analysis', id: 'data', title: 'Data analysis', takeaway: '', claims: [], sources: [], rag: 'red',
      computationIds: ['a'.repeat(64)], figurePaths: ['trop2_analysis.png'],
    };
    expect(migrateSectionsToV1([legacy, analysis]).map((section) => section.kind))
      .toEqual(['research', 'analysis']);
    expect(() => SectionSchema.parse(legacy)).toThrow();
  });
});
