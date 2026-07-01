import { describe, it, expect } from 'vitest';
import {
  normalizePatentNumber, mapLegalCode, deriveMemberStatus, estimateExpiry,
  getAccessToken, resetTokenCache, lookupPatent,
} from './epoPatent.js';
import type { LegalEvent, Fetch } from './epoPatent.js';

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

// Minimal OPS-shaped JSON fixtures. Applicants deliberately use the single-object
// shape in biblio to exercise the defensive object-or-array coercion.
const BIBLIO = {
  'ops:world-patent-data': { 'exchange-documents': { 'exchange-document': {
    'bibliographic-data': {
      'parties': {
        'applicants': { applicant: { 'applicant-name': { name: { $: 'ACME BIO INC' } } } },
        'inventors': { inventor: [{ 'inventor-name': { name: { $: 'DOE, JANE' } } }] },
      },
      'invention-title': { $: 'Anti-CDCP1 antibodies' },
      'publication-reference': { 'document-id': [{ date: { $: '20200101' } }] },
      'application-reference': { 'document-id': [{ date: { $: '20050615' } }] },
      'patent-classifications': { 'patent-classification': [{ 'section': { $: 'C' }, 'class': { $: '07' } }] },
    },
  } } },
};
const FAMILY = {
  'ops:world-patent-data': { 'ops:patent-family': { 'ops:family-member': [
    { 'publication-reference': { 'document-id': [{ 'country': { $: 'US' }, 'doc-number': { $: '10123456' }, 'kind': { $: 'B2' } }] } },
    { 'publication-reference': { 'document-id': [{ 'country': { $: 'EP' }, 'doc-number': { $: '1234567' }, 'kind': { $: 'B1' } }] } },
  ] } },
};
const LEGAL = {
  'ops:world-patent-data': { 'ops:legal': [
    { '@country': 'US', '@doc-number': '10123456', 'ops:legal': { '@code': 'PG25', 'ops:L018EP': { $: '' } }, '@desc': 'GRANT', '@date': '20180101' },
    { '@country': 'EP', '@doc-number': '1234567', 'ops:legal': { '@code': 'MM4A' }, '@desc': 'LAPSE', '@date': '20220101' },
  ] },
};

function opsFetch(): Fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/auth/accesstoken')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 1200 }), { status: 200 });
    if (u.includes('/published-data/')) return new Response(JSON.stringify(BIBLIO), { status: 200 });
    if (u.includes('/family/')) return new Response(JSON.stringify(FAMILY), { status: 200 });
    if (u.includes('/legal/')) return new Response(JSON.stringify(LEGAL), { status: 200 });
    throw new Error(`unexpected url ${u}`);
  }) as unknown as Fetch;
}

describe('lookupPatent', () => {
  const creds = { key: 'k', secret: 's', base: 'https://ops.epo.org/3.2', nowMs: 0 };

  it('assembles a PatentRecord with applicant, family, and derived legal status', async () => {
    resetTokenCache();
    const rec = await lookupPatent('US 10,123,456 B2', { fetchImpl: opsFetch(), ...creds });
    expect(rec.found).toBe(true);
    expect(rec.normalized).toBe('US10123456');
    expect(rec.applicants).toEqual(['ACME BIO INC']);       // single-object shape coerced
    expect(rec.title).toBe('Anti-CDCP1 antibodies');
    expect(rec.family.map((m) => `${m.country}${m.number}`)).toEqual(['US10123456', 'EP1234567']);
    expect(rec.family.find((m) => m.country === 'EP')?.status).toBe('inactive'); // MM4A lapse
    expect(rec.expiryEstimated).toBe(true);
    expect(rec.estimatedExpiry).toBe('2025-06-15');         // application date 2005-06-15 + 20
  });

  it('returns EPO_NORMALIZE_FAILED for an unparseable number without throwing', async () => {
    resetTokenCache();
    const rec = await lookupPatent('garbage', { fetchImpl: opsFetch(), ...creds });
    expect(rec.found).toBe(false);
    expect(rec.error).toMatch(/^EPO_NORMALIZE_FAILED:/);
  });

  it('returns EPO_CONFIG_MISSING when credentials are absent', async () => {
    resetTokenCache();
    const rec = await lookupPatent('US10123456', { fetchImpl: opsFetch(), key: '', secret: '', base: creds.base, nowMs: 0 });
    expect(rec.found).toBe(false);
    expect(rec.error).toMatch(/^EPO_CONFIG_MISSING:/);
  });

  it('returns EPO_NOT_FOUND on a 404 from biblio', async () => {
    resetTokenCache();
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/auth/accesstoken')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 1200 }), { status: 200 });
      if (u.includes('/published-data/')) return new Response('', { status: 404 });
      return new Response('{}', { status: 200 });
    }) as unknown as Fetch;
    const rec = await lookupPatent('US10123456', { fetchImpl, ...creds });
    expect(rec.found).toBe(false);
    expect(rec.error).toMatch(/^EPO_NOT_FOUND:/);
  });

  it('returns EPO_AUTH_FAILED on a 401 from the token endpoint', async () => {
    resetTokenCache();
    const fetchImpl = (async () => new Response('', { status: 401 })) as unknown as Fetch;
    const rec = await lookupPatent('US10123456', { fetchImpl, ...creds });
    expect(rec.found).toBe(false);
    expect(rec.error).toMatch(/^EPO_AUTH_FAILED:/);
  });

  it('returns EPO_NETWORK_ERROR when a fetch rejects', async () => {
    resetTokenCache();
    const fetchImpl = (async () => { throw new Error('socket hang up'); }) as unknown as Fetch;
    const rec = await lookupPatent('US10123456', { fetchImpl, ...creds });
    expect(rec.found).toBe(false);
    expect(rec.error).toMatch(/^EPO_NETWORK_ERROR:/);
  });
});
