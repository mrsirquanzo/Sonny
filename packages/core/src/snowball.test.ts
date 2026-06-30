import { describe, it, expect } from 'vitest';
import type { Tool } from '@sonny/mcp-gateway';
import type { Evidence } from '@sonny/shared';
import { EvidenceStore } from './evidenceStore.js';
import { snowballCitations } from './snowball.js';

function tool(name: string, evidence: object[]): Tool {
  return { name, description: name, async call() { return evidence as never; } };
}
const seed: Evidence = { id: 'PMID:111', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 seminal', snippet: '', passage: 'CDCP1', url: 'u', raw: {}, retrievedAt: 'now' };

describe('snowballCitations', () => {
  it('title-gates citers and hydrates the top 3 into the store', async () => {
    const citations = tool('europepmc_citations', [
      { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 in NPC', snippet: '', passage: '', url: 'u', raw: {}, retrievedAt: 'now' },
      { id: 'PMID:2', kind: 'publication', source: 'Europe PMC', title: 'unrelated immunology', snippet: '', passage: '', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);
    // hydrate returns the full record for whichever EXT_ID was asked; here a CDCP1 paper.
    const search = tool('europepmc_search', [
      { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 in NPC', snippet: '', passage: 'CDCP1 drives NPC.', url: 'u', raw: { pmcid: 'PMCX', isOpenAccess: true }, retrievedAt: 'now' },
    ]);
    const store = new EvidenceStore();
    await snowballCitations({ seed, terms: ['cdcp1'], tools: [citations, search], store, emit: () => {} });
    const ids = store.all().map((e) => e.id);
    expect(ids).toContain('PMID:1');     // on-target citer hydrated + registered
    expect(ids).not.toContain('PMID:2'); // off-target citer dropped at the title gate
  });

  it('returns without throwing when the citations tool is absent', async () => {
    const search = tool('europepmc_search', []);
    await expect(snowballCitations({ seed, terms: ['cdcp1'], tools: [search], store: new EvidenceStore(), emit: () => {} })).resolves.toBeUndefined();
  });

  it('returns without effect when the seed has no PMID prefix', async () => {
    const citations = tool('europepmc_citations', []);
    const search = tool('europepmc_search', []);
    const nonPmidSeed: Evidence = { ...seed, id: 'PMCID:PMC1#sec-0' };
    const store = new EvidenceStore();
    await snowballCitations({ seed: nonPmidSeed, terms: ['cdcp1'], tools: [citations, search], store, emit: () => {} });
    expect(store.all()).toEqual([]);
  });
});
