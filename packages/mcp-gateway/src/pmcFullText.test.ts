import { describe, it, expect } from 'vitest';
import { pmcFullTextTool } from './pmcFullText.js';

const xml = `<?xml version="1.0"?><article><body>
  <sec><title>Introduction</title><p>CDCP1 is a CUB-domain transmembrane protein.</p></sec>
  <sec><title>Results</title><p>CDCP1 promotes EMT in NPC cells.</p><p>Knockdown reduced migration.</p></sec>
</body></article>`;

const fakeFetch = (async (url) => {
  expect(String(url)).toContain('efetch.fcgi');
  expect(String(url)).toContain('db=pmc');
  expect(String(url)).toContain('id=7897327');
  return new Response(xml, { status: 200 });
}) as unknown as typeof fetch;

describe('pmcFullTextTool', () => {
  it('returns one passage evidence per body section with title as locator', async () => {
    const out = await pmcFullTextTool.call({ pmcid: 'PMC7897327' }, fakeFetch);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('PMCID:PMC7897327#sec-0');
    expect(out[0].locator).toBe('Introduction');
    expect(out[0].passage).toContain('CUB-domain transmembrane protein');
    expect(out[1].locator).toBe('Results');
    expect(out[1].passage).toContain('promotes EMT');
    expect(out[1].passage).toContain('reduced migration');
  });

  it('returns [] when pmcid is missing', async () => {
    expect(await pmcFullTextTool.call({ pmcid: '' }, fakeFetch)).toHaveLength(0);
  });
});
