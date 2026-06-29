import { describe, it, expect } from 'vitest';
import type { Tool } from '@sonny/mcp-gateway';
import type { TraceEvent } from '@sonny/shared';
import { EvidenceStore } from './evidenceStore.js';
import { produceResearchSection } from './produceResearchSection.js';

function tool(name: string, evidence: object[]): Tool {
  return { name, description: name, async call() { return evidence as never; } };
}

describe('produceResearchSection', () => {
  it('runs the loop, grounds, verifies, and returns a RAG-rated section', async () => {
    const search = tool('europepmc_search', [
      { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1', snippet: '',
        passage: 'abstract', url: 'u', raw: { pmcid: 'PMC1', isOpenAccess: true }, retrievedAt: 'now' },
    ]);
    const fulltext = tool('pmc_fulltext', [
      { id: 'PMCID:PMC1#sec-1', kind: 'publication', source: 'PMC full text', title: 'Results',
        snippet: 'Results', passage: 'CDCP1 promotes EMT.', locator: 'Results', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);

    const specialistReplies = [
      { questions: ['What is the MOA?'] },
      { claims: [{ id: 'c1', text: 'CDCP1 promotes EMT.', citations: ['PMCID:PMC1#sec-1'], confidence: 0.8 }] },
      { done: true, followups: [], takeaway: 'CDCP1 drives EMT.' },
    ];
    let i = 0;
    const specialistModel = { async generateStructured() { return specialistReplies[i++] as never; } };
    const verifierModel = { async generateStructured() { return { claimId: 'x', status: 'supported', rationale: 'ok' } as never; } };

    const events: TraceEvent[] = [];
    const section = await produceResearchSection({
      brief: { id: 'target_biology', title: 'Target Biology', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: [search, fulltext], store: new EvidenceStore(),
      specialistModel, verifierModel, emit: (e) => events.push(e), budget: { maxRounds: 2 },
    });

    expect(section.id).toBe('target_biology');
    expect(section.takeaway).toBe('CDCP1 drives EMT.');
    expect(section.claims.map((c) => c.id)).toEqual(['c1']);
    expect(section.sources).toContain('PMCID:PMC1#sec-1');
    expect(section.rag).toBe('amber'); // one supported claim, single source -> amber
    expect(events.some((e) => e.type === 'section_complete')).toBe(true);
  });
});
