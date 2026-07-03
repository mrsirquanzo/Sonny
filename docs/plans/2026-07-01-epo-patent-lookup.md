# EPO OPS Patent-Lookup Implementation Plan (Patent Specialist - Slice 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `lookupPatent` module that returns an authoritative structured `PatentRecord` (identity, assignee, INPADOC family, pragmatic legal status) from EPO OPS.

**Architecture:** One module in `packages/mcp-gateway`. Task 1 is pure TypeScript (number normalization, legal-code mapping, coarse status, expiry estimate). Task 2 adds OAuth2 token acquisition with in-memory caching and a clock-skew buffer. Task 3 assembles `lookupPatent` (biblio + family + legal fetch, defensive parse) into the `PatentRecord`. It is a plain typed function, NOT a `Tool`. It NEVER throws - all failures return `{ found: false, error }`. Unit tests inject `fetchImpl`.

**Tech Stack:** TypeScript ESM, Vitest, Node global `fetch`/`Buffer`. Test runner: `pnpm --filter @sonny/mcp-gateway test`.

**Spec:** [docs/specs/2026-07-01-epo-patent-lookup-design.md](../specs/2026-07-01-epo-patent-lookup-design.md).

## Global Constraints

- Never use the em dash; use a plain hyphen.
- Never auto-add a commit co-author.
- ESM relative imports use the `.js` extension.
- Touch only `packages/mcp-gateway/src/epoPatent.ts`, `packages/mcp-gateway/src/epoPatent.test.ts`, and `packages/mcp-gateway/src/index.ts`.
- `lookupPatent` is a plain exported function, NOT a `Tool`, and is NOT added to any tool registry array.
- `lookupPatent` NEVER throws; every failure returns `{ found: false, error: "<CODE>: <reason>" }` with one of: `EPO_CONFIG_MISSING`, `EPO_AUTH_FAILED`, `EPO_NOT_FOUND`, `EPO_NETWORK_ERROR`, `EPO_NORMALIZE_FAILED`.
- Credentials come from `SONNY_EPO_KEY` / `SONNY_EPO_SECRET`; base URL from `SONNY_EPO_BASE` (default `https://ops.epo.org/3.2`).
- Token cache stores expiry as `now + (expires_in - 300) seconds` (5-minute clock-skew buffer).
- Unit tests inject `fetchImpl`; no live network.
- `expiryEstimated` is always `true` when `estimatedExpiry` is present.

## File Structure

- Create: `packages/mcp-gateway/src/epoPatent.ts` - types + pure logic (Task 1), OAuth (Task 2), `lookupPatent` assembly (Task 3).
- Create: `packages/mcp-gateway/src/epoPatent.test.ts` - unit tests for all three tasks.
- Modify: `packages/mcp-gateway/src/index.ts` - export `lookupPatent` and public types.

---

### Task 1: Pure logic (normalization, legal-code map, status, expiry)

**Files:**
- Create: `packages/mcp-gateway/src/epoPatent.ts`
- Test: `packages/mcp-gateway/src/epoPatent.test.ts`

**Interfaces:**
- Produces (types): `NormalizedNumber`, `LegalEffect`, `LegalEvent`, `FamilyMember`, `PatentRecord`.
- Produces (functions): `normalizePatentNumber(input)`, `mapLegalCode(code)`, `deriveMemberStatus(events)`, `estimateExpiry(filingDates)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/mcp-gateway/src/epoPatent.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/mcp-gateway test -- epoPatent`
Expected: FAIL - `epoPatent.js` does not exist yet.

- [ ] **Step 3: Implement the types and pure logic**

Create `packages/mcp-gateway/src/epoPatent.ts`:

```ts
export interface NormalizedNumber {
  country: string;
  number: string;
  kind?: string;
  epodoc: string;
}

export type LegalEffect = 'active' | 'inactive' | 'neutral';

export interface LegalEvent {
  code: string;
  category?: string;
  effect: LegalEffect;
  date?: string;
  description?: string;
}

export interface FamilyMember {
  country: string;
  number: string;
  kind?: string;
  status: 'active' | 'inactive' | 'unknown';
  events: LegalEvent[];
}

export interface PatentRecord {
  input: string;
  normalized?: string;
  found: boolean;
  title?: string;
  applicants: string[];
  inventors: string[];
  ipc: string[];
  publicationDate?: string;
  family: FamilyMember[];
  estimatedExpiry?: string;
  expiryEstimated?: true;
  error?: string;
}

// Curated high-signal INPADOC legal-event codes. Illustrative and extensible;
// refined against real OPS legal data during the smoke.
const LEGAL_CODE_MAP: Record<string, { category: string; effect: LegalEffect }> = {
  PG25: { category: 'granted', effect: 'active' },
  FG4D: { category: 'granted', effect: 'active' },
  MM4A: { category: 'lapsed-nonpayment', effect: 'inactive' },
  PLFP: { category: 'fee-paid', effect: 'active' },
  PLBE: { category: 'lapsed', effect: 'inactive' },
  MK9A: { category: 'expired', effect: 'inactive' },
  WD: { category: 'withdrawn', effect: 'inactive' },
};

export function normalizePatentNumber(input: string): NormalizedNumber | null {
  const cleaned = input.replace(/[\s,.\-]/g, '').toUpperCase();
  const m = cleaned.match(/^([A-Z]{2})(\d+)([A-Z]\d?)?$/);
  if (!m) return null;
  const [, country, number, kind] = m;
  return { country, number, kind: kind || undefined, epodoc: `${country}${number}` };
}

export function mapLegalCode(code: string): { category?: string; effect: LegalEffect } {
  const hit = LEGAL_CODE_MAP[code];
  return hit ? { category: hit.category, effect: hit.effect } : { effect: 'neutral' };
}

export function deriveMemberStatus(events: LegalEvent[]): 'active' | 'inactive' | 'unknown' {
  const directional = events
    .filter((e) => e.effect !== 'neutral')
    .slice()
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  const latest = directional[directional.length - 1];
  if (!latest) return 'unknown';
  return latest.effect === 'inactive' ? 'inactive' : 'active';
}

export function estimateExpiry(filingDates: string[]): string | undefined {
  const valid = filingDates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const earliest = valid[0];
  if (!earliest) return undefined;
  const [y, mo, d] = earliest.split('-');
  return `${Number(y) + 20}-${mo}-${d}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/mcp-gateway test -- epoPatent`
Expected: PASS - all Task 1 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-gateway/src/epoPatent.ts packages/mcp-gateway/src/epoPatent.test.ts
git commit -m "feat(mcp-gateway): EPO patent-number normalization, legal-code map, status and expiry helpers"
```

---

### Task 2: OAuth2 token acquisition and caching

**Files:**
- Modify: `packages/mcp-gateway/src/epoPatent.ts` (append; add `import` at top if any)
- Test: `packages/mcp-gateway/src/epoPatent.test.ts` (append)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `type Fetch = typeof fetch`; `getAccessToken(deps: { fetchImpl: Fetch; key: string; secret: string; base: string; nowMs: number }): Promise<string>`; `resetTokenCache(): void` (test helper to clear module state).
- Token cache is module-level. Expiry stored as `nowMs + (expires_in - 300) * 1000`. `getAccessToken` returns the cached token when `nowMs < expiry`, else fetches a new one.

- [ ] **Step 1: Write the failing tests**

Append to `packages/mcp-gateway/src/epoPatent.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/mcp-gateway test -- epoPatent`
Expected: FAIL - `getAccessToken` / `resetTokenCache` are not exported yet.

- [ ] **Step 3: Implement the token cache**

Append to `packages/mcp-gateway/src/epoPatent.ts`:

```ts
export type Fetch = typeof fetch;

const TOKEN_BUFFER_S = 300; // clock-skew safety buffer

let tokenCache: { token: string; expiryMs: number } | null = null;

export function resetTokenCache(): void {
  tokenCache = null;
}

export async function getAccessToken(deps: {
  fetchImpl: Fetch; key: string; secret: string; base: string; nowMs: number;
}): Promise<string> {
  if (tokenCache && deps.nowMs < tokenCache.expiryMs) return tokenCache.token;
  const res = await deps.fetchImpl(`${deps.base}/auth/accesstoken`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${deps.key}:${deps.secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`token HTTP ${res.status}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: body.access_token, expiryMs: deps.nowMs + (body.expires_in - TOKEN_BUFFER_S) * 1000 };
  return tokenCache.token;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/mcp-gateway test -- epoPatent`
Expected: PASS - all Task 1 and Task 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-gateway/src/epoPatent.ts packages/mcp-gateway/src/epoPatent.test.ts
git commit -m "feat(mcp-gateway): EPO OAuth token acquisition with clock-skew-buffered cache"
```

---

### Task 3: `lookupPatent` assembly and index export

**Files:**
- Modify: `packages/mcp-gateway/src/epoPatent.ts` (append)
- Test: `packages/mcp-gateway/src/epoPatent.test.ts` (append)
- Modify: `packages/mcp-gateway/src/index.ts`

**Interfaces:**
- Consumes: all Task 1 + Task 2 exports.
- Produces: `lookupPatent(input: string, deps?: { fetchImpl?: Fetch; key?: string; secret?: string; base?: string; nowMs?: number }): Promise<PatentRecord>`.
- Defaults: `fetchImpl` -> global `fetch`; `key`/`secret` -> `process.env.SONNY_EPO_KEY` / `SONNY_EPO_SECRET`; `base` -> `process.env.SONNY_EPO_BASE ?? 'https://ops.epo.org/3.2'`; `nowMs` -> `Date.now()`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/mcp-gateway/src/epoPatent.test.ts`:

```ts
import { lookupPatent } from './epoPatent.js';

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/mcp-gateway test -- epoPatent`
Expected: FAIL - `lookupPatent` is not exported yet.

- [ ] **Step 3: Implement `lookupPatent`**

Append to `packages/mcp-gateway/src/epoPatent.ts`:

```ts
function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function text(node: unknown): string | undefined {
  const t = (node as { $?: unknown } | undefined)?.$;
  return typeof t === 'string' && t.length > 0 ? t : undefined;
}

// Convert EPO's YYYYMMDD to YYYY-MM-DD.
function isoDate(raw?: string): string | undefined {
  if (!raw || !/^\d{8}$/.test(raw)) return undefined;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

class EpoError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

async function getJson(url: string, token: string, fetchImpl: Fetch): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  } catch (e) {
    throw new EpoError('EPO_NETWORK_ERROR', (e as Error).message);
  }
  if (res.status === 404) throw new EpoError('EPO_NOT_FOUND', `404 for ${url}`);
  if (res.status === 401) throw new EpoError('EPO_AUTH_FAILED', `401 for ${url}`);
  if (!res.ok) throw new EpoError('EPO_NETWORK_ERROR', `HTTP ${res.status} for ${url}`);
  try {
    return await res.json();
  } catch {
    throw new EpoError('EPO_NETWORK_ERROR', `non-JSON body for ${url}`);
  }
}

function parseBiblio(json: unknown): { title?: string; applicants: string[]; inventors: string[]; ipc: string[]; publicationDate?: string; filingDate?: string } {
  const bib = (json as any)?.['ops:world-patent-data']?.['exchange-documents']?.['exchange-document']?.['bibliographic-data'];
  const parties = bib?.parties;
  const applicants = asArray(parties?.applicants?.applicant).map((a: any) => text(a?.['applicant-name']?.name)).filter(Boolean) as string[];
  const inventors = asArray(parties?.inventors?.inventor).map((a: any) => text(a?.['inventor-name']?.name)).filter(Boolean) as string[];
  const title = text(bib?.['invention-title']);
  const publicationDate = isoDate(asArray(bib?.['publication-reference']?.['document-id']).map((d: any) => text(d?.date)).find(Boolean));
  const filingDate = isoDate(asArray(bib?.['application-reference']?.['document-id']).map((d: any) => text(d?.date)).find(Boolean));
  const ipc = asArray(bib?.['patent-classifications']?.['patent-classification'])
    .map((c: any) => `${text(c?.section) ?? ''}${text(c?.class) ?? ''}`).filter((s: string) => s.length > 0);
  return { title, applicants, inventors, ipc, publicationDate, filingDate };
}

function parseFamily(json: unknown): Array<{ country: string; number: string; kind?: string }> {
  const members = asArray((json as any)?.['ops:world-patent-data']?.['ops:patent-family']?.['ops:family-member']);
  return members.map((m: any) => {
    const doc = asArray(m?.['publication-reference']?.['document-id'])[0];
    return { country: text(doc?.country) ?? '', number: text(doc?.['doc-number']) ?? '', kind: text(doc?.kind) };
  }).filter((m) => m.country && m.number);
}

function parseLegal(json: unknown): Record<string, LegalEvent[]> {
  const rows = asArray((json as any)?.['ops:world-patent-data']?.['ops:legal']);
  const byMember: Record<string, LegalEvent[]> = {};
  for (const r of rows as any[]) {
    const country = r?.['@country'] ?? '';
    const number = r?.['@doc-number'] ?? '';
    const code = r?.['ops:legal']?.['@code'] ?? r?.['@code'] ?? '';
    if (!country || !number || !code) continue;
    const mapped = mapLegalCode(code);
    const key = `${country}${number}`;
    (byMember[key] ??= []).push({ code, category: mapped.category, effect: mapped.effect, date: isoDate(r?.['@date']), description: r?.['@desc'] });
  }
  return byMember;
}

export async function lookupPatent(
  input: string,
  deps: { fetchImpl?: Fetch; key?: string; secret?: string; base?: string; nowMs?: number } = {},
): Promise<PatentRecord> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const key = deps.key ?? process.env.SONNY_EPO_KEY ?? '';
  const secret = deps.secret ?? process.env.SONNY_EPO_SECRET ?? '';
  const base = deps.base ?? process.env.SONNY_EPO_BASE ?? 'https://ops.epo.org/3.2';
  const nowMs = deps.nowMs ?? Date.now();

  const empty: PatentRecord = { input, found: false, applicants: [], inventors: [], ipc: [], family: [] };

  const norm = normalizePatentNumber(input);
  if (!norm) return { ...empty, error: `EPO_NORMALIZE_FAILED: could not parse "${input}"` };
  if (!key || !secret) return { ...empty, normalized: norm.epodoc, error: 'EPO_CONFIG_MISSING: SONNY_EPO_KEY / SONNY_EPO_SECRET not set' };

  try {
    let token: string;
    try {
      token = await getAccessToken({ fetchImpl, key, secret, base, nowMs });
    } catch {
      return { ...empty, normalized: norm.epodoc, error: 'EPO_AUTH_FAILED: token request failed' };
    }
    // Biblio is the identity gate: its 404/401/network error decides found/error.
    const biblioJson = await getJson(`${base}/rest-services/published-data/publication/epodoc/${norm.epodoc}/biblio`, token, fetchImpl);
    // Family and legal are best-effort: a patent with no legal/family data is still "found".
    const [familyJson, legalJson] = await Promise.all([
      getJson(`${base}/rest-services/family/publication/epodoc/${norm.epodoc}`, token, fetchImpl).catch(() => null),
      getJson(`${base}/rest-services/legal/publication/epodoc/${norm.epodoc}`, token, fetchImpl).catch(() => null),
    ]);
    const biblio = parseBiblio(biblioJson);
    const rawFamily = familyJson ? parseFamily(familyJson) : [];
    const legalByMember = legalJson ? parseLegal(legalJson) : {};
    const family: FamilyMember[] = rawFamily.map((m) => {
      const events = legalByMember[`${m.country}${m.number}`] ?? [];
      return { ...m, status: deriveMemberStatus(events), events };
    });
    const estimatedExpiry = estimateExpiry(biblio.filingDate ? [biblio.filingDate] : []);
    return {
      input, normalized: norm.epodoc, found: true,
      title: biblio.title, applicants: biblio.applicants, inventors: biblio.inventors, ipc: biblio.ipc,
      publicationDate: biblio.publicationDate, family,
      ...(estimatedExpiry ? { estimatedExpiry, expiryEstimated: true as const } : {}),
    };
  } catch (e) {
    const code = e instanceof EpoError ? e.code : 'EPO_NETWORK_ERROR';
    return { ...empty, normalized: norm.epodoc, error: `${code}: ${(e as Error).message}` };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/mcp-gateway test -- epoPatent`
Expected: PASS - all Task 1, 2, and 3 tests pass.

- [ ] **Step 5: Export from the gateway index**

In `packages/mcp-gateway/src/index.ts`, add below the existing exports:

```ts
export { lookupPatent } from './epoPatent.js';
export type { PatentRecord, FamilyMember, LegalEvent, LegalEffect, NormalizedNumber } from './epoPatent.js';
```

- [ ] **Step 6: Run the full gateway suite**

Run: `pnpm --filter @sonny/mcp-gateway test`
Expected: PASS - all gateway tests green (BLAST, ANARCI, and the new EPO tests).

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-gateway/src/epoPatent.ts packages/mcp-gateway/src/epoPatent.test.ts packages/mcp-gateway/src/index.ts
git commit -m "feat(mcp-gateway): add lookupPatent EPO OPS module with soft-degrading PatentRecord"
```

---

## Notes for the controller

- Manual smoke (not a unit test), after setting `SONNY_EPO_KEY` / `SONNY_EPO_SECRET`: run `lookupPatent` against a known granted patent and confirm the OPS JSON nesting matches the fixtures (applicant/title paths, family member shape, legal event `@code`/`@date`). Adjust the parse paths and `LEGAL_CODE_MAP` against real data; the TypeScript contract and error semantics stay fixed.
- The stderr warning on a degraded (`found: false`) lookup is a slice-5 orchestration responsibility, not part of this module.
- Out of scope: claims/full-text (slice 4), definitive term-adjustment math, an LLM-callable tool wrapper (slice 5).
