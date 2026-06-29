import { describe, it, expect } from 'vitest';
import type { Section } from '@sonny/shared';
import type { StructuredModel } from './model.js';
import { assessCompleteness } from './completeness.js';
import { EvidenceStore } from './evidenceStore.js';
import { fillGap, mergeGapClaims } from './completeness.js';
import type { Tool } from '@sonny/mcp-gateway';
import type { Claim } from '@sonny/shared';

const sections: Section[] = [
  { id: 'target_biology', title: 'Target Biology', takeaway: 'Solid.', claims: [], sources: ['ENSG1', 'PMID:1'], rag: 'green' },
  { id: 'clinical_landscape', title: 'Clinical Landscape', takeaway: 'Thin.', claims: [], sources: [], rag: 'red' },
];

describe('assessCompleteness', () => {
  it('returns the critic verdict and includes the section summaries in the prompt', async () => {
    let prompt = '';
    const model: StructuredModel = {
      async generateStructured(opts) {
        prompt = opts.prompt;
        return { complete: false, gaps: [
          { specialistId: 'clinical_landscape', question: 'What trials exist?', searchQuery: 'CDCP1 clinical trial', reason: 'section is red' },
        ] } as never;
      },
    };
    const out = await assessCompleteness(sections, model);
    expect(out.complete).toBe(false);
    expect(out.gaps[0].specialistId).toBe('clinical_landscape');
    expect(prompt).toContain('Clinical Landscape');
    expect(prompt).toContain('red');
  });
});

function gapTool(name: string, evidence: object[]): Tool {
  return { name, description: name, async call() { return evidence as never; } };
}

describe('fillGap', () => {
  it('searches, reads, extracts, grounds, and returns only verifier-supported claims', async () => {
    const search = gapTool('europepmc_search', [
      { id: 'PMID:9', kind: 'publication', source: 'Europe PMC', title: 'X', snippet: '', passage: 'abs', url: 'u', raw: { pmcid: 'PMC9', isOpenAccess: true }, retrievedAt: 'now' },
    ]);
    const fulltext = gapTool('pmc_fulltext', [
      { id: 'PMCID:PMC9#sec-0', kind: 'publication', source: 'PMC full text', title: 'R', snippet: '', passage: 'resistance via bypass', locator: 'R', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);
    const specialistModel = { async generateStructured() {
      return { claims: [
        { id: 'g1', text: 'Bypass signaling drives resistance.', citations: ['PMCID:PMC9#sec-0'], confidence: 0.7 },
        { id: 'g2', text: 'Unsupported overreach.', citations: ['PMCID:PMC9#sec-0'], confidence: 0.5 },
      ] } as never;
    } };
    let v = 0;
    const verifierModel = { async generateStructured() {
      return [{ claimId: 'x', status: 'supported', rationale: 'ok' }, { claimId: 'x', status: 'unsupported', rationale: 'no' }][v++] as never;
    } };
    const out = await fillGap({
      gap: { specialistId: 'moa_pathway', question: 'How does resistance arise?', searchQuery: 'CDCP1 resistance', reason: 'gap' },
      tools: [search, fulltext], store: new EvidenceStore(), specialistModel, verifierModel, emit: () => {},
    });
    expect(out.map((c) => c.id)).toEqual(['g1']); // only the supported claim survives
  });
});

describe('fillGap resilience', () => {
  it('does not throw when the search tool fails; returns no claims', async () => {
    const failingSearch: Tool = { name: 'europepmc_search', description: '', async call() { throw new Error('HTTP 504'); } };
    const fulltext: Tool = { name: 'pmc_fulltext', description: '', async call() { return []; } };
    const specialistModel = { async generateStructured() { return { claims: [] } as never; } };
    const verifierModel = { async generateStructured() { return { claimId: 'x', status: 'supported', rationale: '' } as never; } };
    const out = await fillGap({
      gap: { specialistId: 'moa_pathway', question: 'q', searchQuery: 'kw', reason: 'r' },
      tools: [failingSearch, fulltext], store: new EvidenceStore(),
      specialistModel, verifierModel, emit: () => {},
    });
    expect(out).toEqual([]);
  });
});

describe('mergeGapClaims', () => {
  it('appends claims, unions sources, and recomputes RAG to green at two distinct sources', () => {
    const section = { id: 'x', title: 'X', takeaway: 't', claims: [
      { id: 'c1', text: 'a', citations: ['PMID:1'], confidence: 0.8 } as Claim,
    ], sources: ['PMID:1'], rag: 'amber' as const };
    const merged = mergeGapClaims(section, [{ id: 'c2', text: 'b', citations: ['PMID:2'], confidence: 0.7 }]);
    expect(merged.claims.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(merged.sources.sort()).toEqual(['PMID:1', 'PMID:2']);
    expect(merged.rag).toBe('green');
  });
});
