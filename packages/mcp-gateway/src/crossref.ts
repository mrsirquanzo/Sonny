export interface CrossrefMetadata {
  found: boolean;
  title?: string;
  journal?: string;
  year?: string;
}

interface CrossrefResponse {
  message?: {
    title?: string[];
    'container-title'?: string[];
    issued?: { 'date-parts'?: Array<Array<number | string>> };
  };
}

export async function verifyDoi(
  doi: string,
  fetchImpl: typeof fetch = fetch,
  mailto = 'sonny@localhost',
): Promise<CrossrefMetadata> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(mailto)}`;
    const response = await fetchImpl(url, { signal: controller.signal });
    if (response.status !== 200) return { found: false };

    const body = await response.json() as CrossrefResponse;
    const message = body.message;
    const title = message?.title?.[0];
    const journal = message?.['container-title']?.[0];
    const issuedYear = message?.issued?.['date-parts']?.[0]?.[0];
    return {
      found: true,
      ...(title ? { title } : {}),
      ...(journal ? { journal } : {}),
      ...(issuedYear !== undefined ? { year: String(issuedYear) } : {}),
    };
  } catch {
    return { found: false };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function titleMatches(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const normalizedA = normalizeTitle(a);
  const normalizedB = normalizeTitle(b);
  if (!normalizedA || !normalizedB) return false;
  if (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA)) return true;

  const wordsA = new Set(normalizedA.split(' '));
  const wordsB = new Set(normalizedB.split(' '));
  const intersection = [...wordsA].filter((word) => wordsB.has(word)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 && intersection / union >= 0.8;
}

export async function verifyEvidenceMetadata(
  input: { doi?: string; title?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ verified: boolean; journal?: string; year?: string; note?: string }> {
  if (!input.doi) return { verified: false, note: 'no doi' };
  const crossref = await verifyDoi(input.doi, fetchImpl);
  if (!crossref.found) return { verified: false, note: 'doi not found on crossref' };

  const verified = titleMatches(input.title, crossref.title);
  return {
    verified,
    ...(crossref.journal ? { journal: crossref.journal } : {}),
    ...(crossref.year ? { year: crossref.year } : {}),
    ...(!verified ? { note: 'title mismatch' } : {}),
  };
}
