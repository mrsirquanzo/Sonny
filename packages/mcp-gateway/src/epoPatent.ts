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
