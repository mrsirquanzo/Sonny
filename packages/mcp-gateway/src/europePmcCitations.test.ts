import { describe, it, expect } from 'vitest';
import { europePmcCitationsTool } from './europePmcCitations.js';

const payload = { citationList: { citation: [
  { id: '41091621', source: 'MED', title: 'CDCP1 degrader conjugates.', citedByCount: 5, pubYear: '2025' },
  { id: '40725832', source: 'MED', title: 'CD318 in tumor immunity.', citedByCount: 3, pubYear: '2025' },
  { id: 'PPR9', source: 'PPR', title: 'A preprint.', citedByCount: 0, pubYear: '2025' },
] } };

const fakeFetch = (async (url: string) => {
  expect(String(url)).toContain('/MED/11466621/citations');
  return new Response(JSON.stringify(payload), { status: 200 });
}) as unknown as typeof fetch;

describe('europePmcCitationsTool', () => {
  it('maps MED citers to PMID evidence with empty passage and drops non-MED entries', async () => {
    const out = await europePmcCitationsTool.call({ pmid: '11466621' }, fakeFetch);
    expect(out.map((e) => e.id)).toEqual(['PMID:41091621', 'PMID:40725832']);
    expect(out[0].passage).toBe('');
    expect((out[0].raw as { citedByCount: number }).citedByCount).toBe(5);
  });

  it('returns [] for an empty pmid without fetching', async () => {
    const out = await europePmcCitationsTool.call({ pmid: '' }, fakeFetch);
    expect(out).toEqual([]);
  });
});
