import { describe, it, expect } from 'vitest';
import { pubmedTool } from './pubmed.js';

const fakeFetch = (async (url: string | URL) => {
  const u = String(url);
  if (u.includes('esearch')) return new Response(JSON.stringify({ esearchresult: { idlist: ['29622564'] } }), { status: 200 });
  return new Response(JSON.stringify({ result: { uids: ['29622564'],
    '29622564': { uid: '29622564', title: 'EGFR mutations in NSCLC', source: 'J Onc', pubdate: '2018' } } }), { status: 200 });
}) as unknown as typeof fetch;

describe('pubmedTool', () => {
  it('normalizes a PubMed hit to canonical PMID evidence', async () => {
    const out = await pubmedTool.call({ query: 'EGFR NSCLC' }, fakeFetch);
    expect(out[0].id).toBe('PMID:29622564');
    expect(out[0].kind).toBe('publication');
    expect(out[0].title).toBe('EGFR mutations in NSCLC');
  });
});
