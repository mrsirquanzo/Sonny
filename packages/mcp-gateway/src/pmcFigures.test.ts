import { describe, it, expect } from 'vitest';
import { pmcFiguresTool } from './pmcFigures.js';

const xml = `<?xml version="1.0"?><pmc-articleset><article><body>
  <sec><title>Results</title><p>Efficacy was observed.</p>
    <fig id="F2"><label>Figure 2</label>
      <caption><p>Forest plot of overall survival. Pooled HR 0.62 (95% CI 0.48-0.79).</p></caption>
      <graphic xlink:href="pone.0000002.g002"/>
    </fig>
  </sec>
</body></article></pmc-articleset>`;

const okFetch = (async () => new Response(xml, { status: 200 })) as unknown as typeof fetch;

describe('pmcFiguresTool', () => {
  it('parses figures into caption-anchored Evidence', async () => {
    const out = await pmcFiguresTool.call({ pmcid: 'PMC7897327' }, okFetch);
    expect(out).toHaveLength(1);
    const f = out[0];
    expect(f.id).toBe('PMCID:PMC7897327#fig-0');
    expect(f.kind).toBe('figure');
    expect(f.title).toBe('Figure 2');
    expect(f.passage).toContain('Pooled HR 0.62');
    expect(f.locator).toBe('fig-0');
    expect(f.url).toContain('/PMC7897327/bin/pone.0000002.g002');
    expect(f.metadata?.imageRef).toBe('pone.0000002.g002');
  });

  it('returns [] for a missing pmcid', async () => {
    expect(await pmcFiguresTool.call({}, okFetch)).toEqual([]);
  });

  it('throws on non-OK HTTP so safeToolCall can isolate it', async () => {
    const bad = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    await expect(pmcFiguresTool.call({ pmcid: 'PMC1' }, bad)).rejects.toThrow(/HTTP 500/);
  });
});
