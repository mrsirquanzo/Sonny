import { describe, it, expect } from 'vitest';
import { europePmcSearchTool } from './europePmc.js';

const payload = { resultList: { result: [
  { id: '33611339', source: 'MED', pmid: '33611339', pmcid: 'PMC7897327',
    title: 'CDCP1 review.', abstractText: 'CDCP1 is a transmembrane protein.',
    citedByCount: '1636', isOpenAccess: 'Y', firstPublicationDate: '2021-02-21',
    pubTypeList: { pubType: ['review-article', 'Review', 'Journal Article'] } },
  { id: '40000001', source: 'MED', pmid: '40000001', pmcid: '',
    title: 'CDCP1 primary study.', abstractText: 'CDCP1 promotes EMT.',
    citedByCount: '12', isOpenAccess: 'N', firstPublicationDate: '2024-01-01',
    pubTypeList: { pubType: ['Journal Article'] } },
] } };

const fakeFetch = (async (url) => {
  expect(String(url)).toContain('/europepmc/webservices/rest/search');
  return new Response(JSON.stringify(payload), { status: 200 });
}) as unknown as typeof fetch;

describe('europePmcSearchTool', () => {
  it('returns citation-ranked publication evidence with abstract as passage and review flag', async () => {
    const out = await europePmcSearchTool.call({ query: 'CDCP1 cancer' }, fakeFetch);
    expect(out.map((e) => e.id)).toEqual(['PMID:33611339', 'PMID:40000001']);
    expect(out[0].kind).toBe('publication');
    expect(out[0].passage).toBe('CDCP1 is a transmembrane protein.');
    expect((out[0].raw as { isReview: boolean }).isReview).toBe(true);
    expect((out[0].raw as { pmcid: string }).pmcid).toBe('PMC7897327');
    expect((out[1].raw as { isReview: boolean }).isReview).toBe(false);
  });

  it('returns [] for an empty query', async () => {
    const out = await europePmcSearchTool.call({ query: '  ' }, fakeFetch);
    expect(out).toHaveLength(0);
  });
});
