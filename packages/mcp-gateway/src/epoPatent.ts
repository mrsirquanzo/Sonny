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
  const cleaned = String(input ?? '').replace(/[\s,.\-]/g, '').toUpperCase();
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

export type Fetch = typeof fetch;

// ---- Task 3: lookupPatent helpers ----

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function text(node: unknown): string | undefined {
  const t = (node as { $?: unknown } | undefined)?.$;
  return typeof t === 'string' && t.length > 0 ? t : undefined;
}

// Convert EPO's YYYYMMDD to YYYY-MM-DD.
function isoDate(raw?: unknown): string | undefined {
  const s = String(raw ?? '');
  if (!/^\d{8}$/.test(s)) return undefined;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function safeParse<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
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
      // Wrap fetchImpl so network-level throws become EpoError and bubble to the outer catch,
      // while an HTTP 401 stays as a plain Error (caught below as EPO_AUTH_FAILED).
      const wrappedFetch: Fetch = async (...args) => {
        let res: Response;
        try {
          res = await (fetchImpl as (...a: unknown[]) => Promise<Response>)(...args);
        } catch (e) {
          throw new EpoError('EPO_NETWORK_ERROR', (e as Error).message);
        }
        return res;
      };
      token = await getAccessToken({ fetchImpl: wrappedFetch, key, secret, base, nowMs });
    } catch (e) {
      if (e instanceof EpoError) throw e; // bubble network errors to outer catch
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
    const rawFamily = familyJson ? safeParse(() => parseFamily(familyJson), []) : [];
    const legalByMember = legalJson ? safeParse(() => parseLegal(legalJson), {} as Record<string, LegalEvent[]>) : {};
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

// ---- end Task 3 ----

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
