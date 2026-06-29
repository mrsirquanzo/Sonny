import { describe, it, expect } from 'vitest';
import type { Tool } from '@sonny/mcp-gateway';
import type { TraceEvent } from '@sonny/shared';
import type { ThreadBrief } from './researcher.js';
import { runDeepResearch } from './runDeepResearch.js';

function tool(name: string, evidence: object[]): Tool {
  return { name, description: name, async call() { return evidence as never; } };
}

const roster: ThreadBrief[] = [
  { id: 'a', title: 'A', objective: 'oa', promptHint: 'ha' },
  { id: 'b', title: 'B', objective: 'ob', promptHint: 'hb' },
];

describe('runDeepResearch', () => {
  it('seeds structured evidence once, dispatches every brief over a shared store, and returns one section per brief', async () => {
    const ot = tool('open_targets_target', [
      { id: 'ENSG1', kind: 'target', source: 'Open Targets', title: 'T', snippet: '', passage: 'tractable', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);
    const search = tool('europepmc_search', [
      { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'P', snippet: '', passage: 'abs', url: 'u', raw: { pmcid: 'PMC1', isOpenAccess: true }, retrievedAt: 'now' },
    ]);
    const fulltext = tool('pmc_fulltext', [
      { id: 'PMCID:PMC1#sec-0', kind: 'publication', source: 'PMC full text', title: 'Results', snippet: '', passage: 'finding', locator: 'Results', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);

    // Two specialists run in PARALLEL, so their plan/extract/reflect calls interleave.
    // Discriminate by the call's system prompt - NOT a positional counter, which would
    // hand one specialist's plan call another specialist's extract reply under Promise.all.
    const specialistModel = { async generateStructured(o: { system: string }) {
      if (o.system.includes('Plan the specific')) return { questions: [{ question: 'q?', searchQuery: 'kw' }] } as never;
      if (o.system.includes('rigorous biomedical')) return { claims: [{ id: 'c1', text: 'A claim citing ENSG1.', citations: ['ENSG1'], confidence: 0.8 }] } as never;
      return { done: true, followups: [], takeaway: 'takeaway' } as never; // reflect
    } };
    const verifierModel = { async generateStructured() { return { claimId: 'x', status: 'supported', rationale: 'ok' } as never; } };
    const leadModel = { async generateStructured() { return {} as never; } };

    const events: TraceEvent[] = [];
    const result = await runDeepResearch({
      target: 'CDCP1', roster, literatureTools: [search, fulltext], structuredTools: [ot],
      specialistModel, verifierModel, leadModel, emit: (e) => events.push(e), budget: { maxRounds: 1 },
    });

    expect(result.sections.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(events.some((e) => e.type === 'lead_decompose')).toBe(true);
    // structured seed evidence is visible to specialists (claim cites the seeded ENSG1)
    expect(result.sections.every((s) => s.claims.length === 1)).toBe(true);
    expect(result.weighing).toEqual({ takeaway: '', claims: [] });
  });
});
