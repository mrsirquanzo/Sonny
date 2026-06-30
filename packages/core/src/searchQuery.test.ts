import { describe, it, expect } from 'vitest';
import { buildSearchQuery } from './searchQuery.js';

describe('buildSearchQuery', () => {
  it('joins target and a single-word concept with AND', () => {
    expect(buildSearchQuery('CDCP1', 'ADC')).toBe('CDCP1 AND ADC');
  });

  it('phrase-quotes a multi-word concept so it is not AND-split', () => {
    expect(buildSearchQuery('CDCP1', 'cell therapy')).toBe('CDCP1 AND "cell therapy"');
  });

  it('returns the target alone when the concept is empty or whitespace', () => {
    expect(buildSearchQuery('CDCP1', '')).toBe('CDCP1');
    expect(buildSearchQuery('CDCP1', '   ')).toBe('CDCP1');
  });

  it('trims surrounding whitespace from the concept', () => {
    expect(buildSearchQuery('CDCP1', '  oncology  ')).toBe('CDCP1 AND oncology');
  });
});
