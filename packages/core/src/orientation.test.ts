import { describe, it, expect } from 'vitest';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import type { TraceEvent } from '@mrsirquanzo/sonny-shared';
import { EvidenceStore } from './evidenceStore.js';
import { orientWithReview } from './orientation.js';

function tool(name: string, evidence: object[]): Tool {
  return { name, description: name, async call() { return evidence as never; } };
}

function seededStore() {
  const store = new EvidenceStore();
  store.register({ id: 'ENSG1', kind: 'target', source: 'Open Targets', title: 'CDCP1', snippet: '', url: 'u', retrievedAt: 'now',
    raw: { approvedSymbol: 'CDCP1', synonyms: ['CD318'] } });
  return store;
}

describe('orientWithReview', () => {
  it('registers the top 2 target-mentioning review abstracts', async () => {
    const search = tool('europepmc_search', [
      { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'The CDCP1 signaling hub review', snippet: '', passage: 'CDCP1 landscape', url: 'u', raw: { pmcid: '', isReview: true, isOpenAccess: false }, retrievedAt: 'now' },
      { id: 'PMID:2', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 in cancer review', snippet: '', passage: 'CDCP1 overview', url: 'u', raw: { pmcid: '', isReview: true, isOpenAccess: false }, retrievedAt: 'now' },
      { id: 'PMID:3', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 roles review', snippet: '', passage: 'CDCP1 roles', url: 'u', raw: { pmcid: '', isReview: true, isOpenAccess: false }, retrievedAt: 'now' },
    ]);
    const fulltext = tool('pmc_fulltext', []);
    const store = seededStore();
    await orientWithReview({ target: 'CDCP1', tools: [search, fulltext], store, emit: () => {} });
    const ids = store.all().map((e) => e.id);
    expect(ids).toContain('PMID:1');
    expect(ids).toContain('PMID:2');
    expect(ids).not.toContain('PMID:3'); // only top 2 registered
  });

  it('deep-reads an open-access review whose title names the target and drops off-topic sections', async () => {
    const search = tool('europepmc_search', [
      { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'The CDCP1 signaling hub review', snippet: '', passage: 'CDCP1 landscape', url: 'u', raw: { pmcid: 'PMC1', isReview: true, isOpenAccess: true }, retrievedAt: 'now' },
    ]);
    const fulltext = tool('pmc_fulltext', [
      { id: 'PMCID:PMC1#sec-0', kind: 'publication', source: 'PMC full text', title: 'CDCP1 biology', snippet: '', passage: 'CDCP1 drives invasion.', locator: 'CDCP1 biology', url: 'u', raw: {}, retrievedAt: 'now' },
      { id: 'PMCID:PMC1#sec-1', kind: 'publication', source: 'PMC full text', title: 'Acknowledgements', snippet: '', passage: 'We thank the funders.', locator: 'Acknowledgements', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);
    const events: TraceEvent[] = [];
    const store = seededStore();
    await orientWithReview({ target: 'CDCP1', tools: [search, fulltext], store, emit: (e) => events.push(e) });
    const ids = store.all().map((e) => e.id);
    expect(ids).toContain('PMCID:PMC1#sec-0');       // on-target section read
    expect(ids).not.toContain('PMCID:PMC1#sec-1');   // off-topic section dropped
    expect(events.some((e) => e.type === 'research_read')).toBe(true);
  });

  it('does not deep-read when no review is open-access', async () => {
    const search = tool('europepmc_search', [
      { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 review', snippet: '', passage: 'CDCP1', url: 'u', raw: { pmcid: '', isReview: true, isOpenAccess: false }, retrievedAt: 'now' },
    ]);
    let fulltextCalls = 0;
    const fulltext: Tool = { name: 'pmc_fulltext', description: '', async call() { fulltextCalls++; return [] as never; } };
    await orientWithReview({ target: 'CDCP1', tools: [search, fulltext], store: seededStore(), emit: () => {} });
    expect(fulltextCalls).toBe(0);
  });

  it('returns without throwing when the literature tools are absent', async () => {
    await expect(orientWithReview({ target: 'CDCP1', tools: [], store: seededStore(), emit: () => {} })).resolves.toBeUndefined();
  });
});
