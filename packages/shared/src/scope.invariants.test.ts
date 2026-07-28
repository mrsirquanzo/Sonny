import { describe, expect, it } from 'vitest';
import {
  REQUIRED_SCOPE_KINDS,
  SectionScopeSchema,
  sectionKey,
} from './index.js';

describe('section scope invariants', () => {
  it('defines the exact legal scope kinds for every axis', () => {
    expect(REQUIRED_SCOPE_KINDS).toEqual({
      target_biology: ['q1_hypothesis'],
      moa_pathway: ['strategy'],
      disease_indications: ['shared', 'strategy'],
      clinical_landscape: ['strategy'],
      competitive_ip: ['strategy'],
      modality_developability: ['strategy'],
    });
  });

  it('requires identity-bearing fields on strategy and Q1 scopes', () => {
    expect(SectionScopeSchema.safeParse({ kind: 'strategy' }).success).toBe(false);
    expect(SectionScopeSchema.safeParse({ kind: 'strategy', strategyFingerprint: '' }).success).toBe(false);
    expect(SectionScopeSchema.safeParse({
      kind: 'q1_hypothesis', q1HypothesisKey: 'h1', relatedStrategyFingerprints: [],
    }).success).toBe(false);
  });

  it('allows a single-strategy scope without a presentation label', () => {
    expect(SectionScopeSchema.parse({
      kind: 'strategy', strategyFingerprint: 'fp-1',
    })).toEqual({ kind: 'strategy', strategyFingerprint: 'fp-1' });
  });

  it('keys strategy scope by fingerprint, never by variant label', () => {
    expect(sectionKey('moa_pathway', {
      kind: 'strategy', strategyFingerprint: 'fp-1', strategyVariantLabel: 'V9',
    })).toBe('moa_pathway::strategy::fp-1');
  });

  it('produces distinct keys for different Q1 hypotheses', () => {
    const one = sectionKey('target_biology', {
      kind: 'q1_hypothesis', q1HypothesisKey: 'hypothesis-a', relatedStrategyFingerprints: ['fp-1'],
    });
    const two = sectionKey('target_biology', {
      kind: 'q1_hypothesis', q1HypothesisKey: 'hypothesis-b', relatedStrategyFingerprints: ['fp-2'],
    });
    expect(one).toBe('target_biology::q1::hypothesis-a');
    expect(two).toBe('target_biology::q1::hypothesis-b');
    expect(one).not.toBe(two);
  });
});
