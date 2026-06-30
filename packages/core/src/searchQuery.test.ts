import { describe, it, expect } from 'vitest';
import { buildSearchQuery } from './searchQuery.js';

describe('buildSearchQuery', () => {
  it('pins the target to TITLE_ABS and joins a single-word concept with AND', () => {
    expect(buildSearchQuery('CDCP1', 'ADC')).toBe('TITLE_ABS:CDCP1 AND ADC');
  });

  it('phrase-quotes a multi-word concept so it is not AND-split', () => {
    expect(buildSearchQuery('CDCP1', 'cell therapy')).toBe('TITLE_ABS:CDCP1 AND "cell therapy"');
  });

  it('returns the field-pinned target alone when the concept is empty or whitespace', () => {
    expect(buildSearchQuery('CDCP1', '')).toBe('TITLE_ABS:CDCP1');
    expect(buildSearchQuery('CDCP1', '   ')).toBe('TITLE_ABS:CDCP1');
  });

  it('trims surrounding whitespace from the concept', () => {
    expect(buildSearchQuery('CDCP1', '  oncology  ')).toBe('TITLE_ABS:CDCP1 AND oncology');
  });
});

import { buildReviewQuery } from './searchQuery.js';

describe('buildReviewQuery', () => {
  it('builds a TITLE_ABS target query constrained to review publications', () => {
    expect(buildReviewQuery('CDCP1')).toBe('TITLE_ABS:CDCP1 AND PUB_TYPE:"review"');
  });
});
