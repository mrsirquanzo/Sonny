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

import { getAccessToken, resetTokenCache } from './epoPatent.js';
import type { Fetch } from './epoPatent.js';

function tokenFetch(token: string, expiresIn: number, calls: { n: number }): Fetch {
  return (async (url: string | URL | Request) => {
    if (String(url).includes('/auth/accesstoken')) {
      calls.n += 1;
      return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), { status: 200 });
    }
    throw new Error(`unexpected url ${String(url)}`);
  }) as unknown as Fetch;
}

describe('getAccessToken', () => {
  it('fetches, caches, and reuses a token within the buffer window', async () => {
    resetTokenCache();
    const calls = { n: 0 };
    const deps = { fetchImpl: tokenFetch('tok-1', 1200, calls), key: 'k', secret: 's', base: 'https://ops.epo.org/3.2' };
    const t1 = await getAccessToken({ ...deps, nowMs: 0 });
    const t2 = await getAccessToken({ ...deps, nowMs: 60_000 }); // 1 min later, within (1200-300)s
    expect(t1).toBe('tok-1');
    expect(t2).toBe('tok-1');
    expect(calls.n).toBe(1); // reused, not refetched
  });

  it('refetches once the buffered expiry has passed', async () => {
    resetTokenCache();
    const calls = { n: 0 };
    const deps = { fetchImpl: tokenFetch('tok-2', 1200, calls), key: 'k', secret: 's', base: 'https://ops.epo.org/3.2' };
    await getAccessToken({ ...deps, nowMs: 0 });
    await getAccessToken({ ...deps, nowMs: 1_000_000 }); // past (1200-300)s = 900s = 900000ms
    expect(calls.n).toBe(2);
  });

  it('sends HTTP Basic auth built from key and secret', async () => {
    resetTokenCache();
    let seenAuth = '';
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seenAuth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
      return new Response(JSON.stringify({ access_token: 'x', expires_in: 1200 }), { status: 200 });
    }) as unknown as Fetch;
    await getAccessToken({ fetchImpl, key: 'k', secret: 's', base: 'https://ops.epo.org/3.2', nowMs: 0 });
    expect(seenAuth).toBe(`Basic ${Buffer.from('k:s').toString('base64')}`);
  });
});
