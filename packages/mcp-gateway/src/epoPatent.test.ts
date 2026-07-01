import { describe, it, expect } from 'vitest';
import {
  normalizePatentNumber, mapLegalCode, deriveMemberStatus, estimateExpiry,
} from './epoPatent.js';
import type { LegalEvent } from './epoPatent.js';

describe('normalizePatentNumber', () => {
  it('strips spaces, commas, and kind code and uppercases the country', () => {
    expect(normalizePatentNumber('US 10,123,456 B2')).toEqual({ country: 'US', number: '10123456', kind: 'B2', epodoc: 'US10123456' });
    expect(normalizePatentNumber('us10123456b2')).toEqual({ country: 'US', number: '10123456', kind: 'B2', epodoc: 'US10123456' });
  });
  it('parses EP and WO numbers with kind codes', () => {
    expect(normalizePatentNumber('EP1234567A1')).toEqual({ country: 'EP', number: '1234567', kind: 'A1', epodoc: 'EP1234567' });
    expect(normalizePatentNumber('WO2020123456A1')).toEqual({ country: 'WO', number: '2020123456', kind: 'A1', epodoc: 'WO2020123456' });
  });
  it('handles a number with no kind code', () => {
    expect(normalizePatentNumber('EP1234567')).toEqual({ country: 'EP', number: '1234567', kind: undefined, epodoc: 'EP1234567' });
  });
  it('returns null for an unrecognizable input', () => {
    expect(normalizePatentNumber('not-a-patent')).toBeNull();
    expect(normalizePatentNumber('12345')).toBeNull();
  });
});

describe('mapLegalCode', () => {
  it('maps a grant code to an active effect and a lapse code to inactive', () => {
    expect(mapLegalCode('PG25').effect).toBe('active');
    expect(mapLegalCode('MM4A').effect).toBe('inactive');
  });
  it('passes an unmapped code through as neutral with no category', () => {
    const m = mapLegalCode('ZZZZ');
    expect(m.effect).toBe('neutral');
    expect(m.category).toBeUndefined();
  });
});

describe('deriveMemberStatus', () => {
  const ev = (code: string, date: string, effect: LegalEvent['effect']): LegalEvent => ({ code, date, effect });
  it('is inactive when the latest directional event is a lapse', () => {
    expect(deriveMemberStatus([ev('PG25', '2018-01-01', 'active'), ev('MM4A', '2022-01-01', 'inactive')])).toBe('inactive');
  });
  it('is active when granted with no later lapse', () => {
    expect(deriveMemberStatus([ev('PG25', '2018-01-01', 'active'), ev('ADDR', '2019-01-01', 'neutral')])).toBe('active');
  });
  it('is unknown with no directional event', () => {
    expect(deriveMemberStatus([ev('ADDR', '2019-01-01', 'neutral')])).toBe('unknown');
    expect(deriveMemberStatus([])).toBe('unknown');
  });
});

describe('estimateExpiry', () => {
  it('returns earliest filing/priority date plus 20 years', () => {
    expect(estimateExpiry(['2005-06-15', '2004-03-01'])).toBe('2024-03-01');
  });
  it('returns undefined when there are no dates', () => {
    expect(estimateExpiry([])).toBeUndefined();
  });
});
