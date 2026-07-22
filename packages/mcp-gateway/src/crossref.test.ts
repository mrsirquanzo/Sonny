import { describe, expect, it, vi } from 'vitest';
import { titleMatches, verifyEvidenceMetadata } from './crossref.js';

function crossrefFetch(message: Record<string, unknown>, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({ message }), { status })) as unknown as typeof fetch;
}

describe('titleMatches', () => {
  it('matches titles after case, punctuation, and whitespace normalization', () => {
    expect(titleMatches('Targeting CDCP1: a cancer review', 'targeting cdcp1 a cancer review')).toBe(true);
  });

  it('matches titles with high word overlap', () => {
    expect(titleMatches('Alpha beta gamma delta epsilon', 'Alpha beta gamma delta epsilon review')).toBe(true);
  });

  it('rejects mismatched or missing titles', () => {
    expect(titleMatches('CDCP1 in cancer', 'Unrelated kidney research')).toBe(false);
    expect(titleMatches(undefined, 'CDCP1 in cancer')).toBe(false);
    expect(titleMatches('CDCP1 in cancer', undefined)).toBe(false);
  });
});

describe('verifyEvidenceMetadata', () => {
  it('verifies a found DOI with a matching title and returns canonical metadata', async () => {
    const fetchImpl = crossrefFetch({
      title: ['Targeting CDCP1: a cancer review'],
      'container-title': ['Canonical Oncology Journal'],
      issued: { 'date-parts': [[2021, 2, 21]] },
    });

    await expect(verifyEvidenceMetadata({
      doi: '10.1000/cdcp1', title: 'Targeting CDCP1 - A Cancer Review',
    }, fetchImpl)).resolves.toEqual({
      verified: true, journal: 'Canonical Oncology Journal', year: '2021',
    });
  });

  it('returns canonical metadata and a note for a title mismatch', async () => {
    const fetchImpl = crossrefFetch({
      title: ['Unrelated kidney research'],
      'container-title': ['Canonical Journal'],
      issued: { 'date-parts': [[2020]] },
    });

    await expect(verifyEvidenceMetadata({
      doi: '10.1000/cdcp1', title: 'CDCP1 in cancer',
    }, fetchImpl)).resolves.toEqual({
      verified: false, journal: 'Canonical Journal', year: '2020', note: 'title mismatch',
    });
  });

  it('returns false when CrossRef does not find the DOI', async () => {
    await expect(verifyEvidenceMetadata(
      { doi: '10.1000/missing', title: 'Missing paper' },
      crossrefFetch({}, 404),
    )).resolves.toEqual({ verified: false, note: 'doi not found on crossref' });
  });

  it('returns false without fetching when the DOI is missing', async () => {
    const fetchImpl = crossrefFetch({});
    await expect(verifyEvidenceMetadata({ title: 'No DOI paper' }, fetchImpl))
      .resolves.toEqual({ verified: false, note: 'no doi' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
