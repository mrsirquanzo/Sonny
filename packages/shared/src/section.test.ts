import { describe, it, expect } from 'vitest';
import { SectionSchema, RagRatingSchema, EvidenceKindSchema } from './contracts.js';

describe('section contracts', () => {
  it('parses a valid section', () => {
    const s = { id: 'target_biology', title: 'Target Biology', takeaway: 'EGFR is tractable.',
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
});
