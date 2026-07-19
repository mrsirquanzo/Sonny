import { describe, it, expect } from 'vitest';
import type { Section } from '@mrsirquanzo/sonny-shared';
import type { StructuredModel } from './model.js';
import { assessCompleteness } from './completeness.js';
import { EvidenceStore } from './evidenceStore.js';
import { fillGap, mergeGapClaims } from './completeness.js';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import type { Claim } from '@mrsirquanzo/sonny-shared';
import { buildSearchQuery } from './searchQuery.js';

const sections: Section[] = [
  { kind: 'research', id: 'target_biology', title: 'Target Biology', takeaway: 'Solid.', claims: [], sources: ['ENSG1', 'PMID:1'], rag: 'green' },
  { kind: 'research', id: 'clinical_landscape', title: 'Clinical Landscape', takeaway: 'Thin.', claims: [], sources: [], rag: 'red' },
];

describe('assessCompleteness', () => {
  it('returns the critic verdict and includes the section summaries in the prompt', async () => {
    let prompt = '';
    const model: StructuredModel = {
      async generateStructured(opts) {
        prompt = opts.prompt;
        return { complete: false, gaps: [
          { specialistId: 'clinical_landscape', question: 'What trials exist?', concept: 'trials', reason: 'section is red' },
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
      gap: { specialistId: 'moa_pathway', question: 'How does resistance arise?', concept: 'resistance', reason: 'gap' },
      target: 'CDCP1', tools: [search, fulltext], store: new EvidenceStore(), specialistModel, verifierModel, emit: () => {},
    });
    // extractClaims auto-assigns ids (c1..cN); assert on text - the meaningful invariant is
    // that only the verifier-supported claim survives.
    expect(out.map((c) => c.text)).toEqual(['Bypass signaling drives resistance.']);
  });
});

describe('fillGap resilience', () => {
  it('does not throw when the search tool fails; returns no claims', async () => {
    const failingSearch: Tool = { name: 'europepmc_search', description: '', async call() { throw new Error('HTTP 504'); } };
    const fulltext: Tool = { name: 'pmc_fulltext', description: '', async call() { return []; } };
    const specialistModel = { async generateStructured() { return { claims: [] } as never; } };
    const verifierModel = { async generateStructured() { return { claimId: 'x', status: 'supported', rationale: '' } as never; } };
    const out = await fillGap({
      gap: { specialistId: 'moa_pathway', question: 'q', concept: 'kw', reason: 'r' },
      target: 'CDCP1', tools: [failingSearch, fulltext], store: new EvidenceStore(),
      specialistModel, verifierModel, emit: () => {},
    });
    expect(out).toEqual([]);
  });
});

describe('fillGap relevance gating', () => {
  it('drops off-target search hits using the seeded target terms', async () => {
    const store = new EvidenceStore();
    store.register({ id: 'ENSG1', kind: 'target', source: 'Open Targets', title: 'CDCP1', snippet: '', url: 'u', retrievedAt: 'now',
      raw: { approvedSymbol: 'CDCP1', synonyms: ['CD318'] } });
    const search: Tool = { name: 'europepmc_search', description: '', async call() {
      return [
        { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 resistance', snippet: '', passage: 'CDCP1 ...', url: 'u', raw: { pmcid: '', isOpenAccess: false }, retrievedAt: 'now' },
        { id: 'PMID:2', kind: 'publication', source: 'Europe PMC', title: 'unrelated NF-kB review', snippet: '', passage: 'NF-kB ...', url: 'u', raw: { pmcid: '', isOpenAccess: false }, retrievedAt: 'now' },
      ] as never;
    } };
    const fulltext: Tool = { name: 'pmc_fulltext', description: '', async call() { return []; } };
    const specialistModel = { async generateStructured() { return { claims: [] } as never; } };
    const verifierModel = { async generateStructured() { return { claimId: 'x', status: 'supported', rationale: '' } as never; } };
    await fillGap({
      gap: { specialistId: 'moa_pathway', question: 'q', concept: 'kw', reason: 'r' },
      target: 'CDCP1', tools: [search, fulltext], store, specialistModel, verifierModel, emit: () => {},
    });
    expect(store.has('PMID:1')).toBe(true);
    expect(store.has('PMID:2')).toBe(false);
  });
});

describe('fillGap query', () => {
  it('searches the broad target AND concept query', async () => {
    const recordedQueries: string[] = [];
    const search: Tool = { name: 'europepmc_search', description: '', async call(args: Record<string, unknown>) { recordedQueries.push(String(args['query'] ?? '')); return [] as never; } };
    const fulltext: Tool = { name: 'pmc_fulltext', description: '', async call() { return [] as never; } };
    const specialistModel = { async generateStructured() { return { claims: [] } as never; } };
    const verifierModel = { async generateStructured() { return { claimId: 'x', status: 'supported', rationale: '' } as never; } };
    await fillGap({
      gap: { specialistId: 'moa_pathway', question: 'How does resistance arise?', concept: 'resistance', reason: 'gap' },
      target: 'CDCP1', tools: [search, fulltext], store: new EvidenceStore(), specialistModel, verifierModel, emit: () => {},
    });
    expect(recordedQueries[0]).toBe(buildSearchQuery('CDCP1', 'resistance')); // 'CDCP1 AND resistance'
  });
});

describe('mergeGapClaims', () => {
  it('appends claims, unions sources, and recomputes RAG to green at two distinct sources', () => {
    const section = { kind: 'research' as const, id: 'x', title: 'X', takeaway: 't', claims: [
      { id: 'c1', text: 'a', citations: ['PMID:1'], confidence: 0.8 } as Claim,
    ], sources: ['PMID:1'], rag: 'amber' as const };
    const merged = mergeGapClaims(
      section,
      [{ id: 'c2', text: 'b', citations: ['PMID:2'], confidence: 0.7 }],
      (id) => id,
    );
    expect(merged.claims.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(merged.sources.sort()).toEqual(['PMID:1', 'PMID:2']);
    expect(merged.rag).toBe('green');
  });
});

import { titleMentionsTarget } from './relevance.js'; // ensure import graph wired

describe('fillGap deep-read gating', () => {
  function seededStore() {
    const store = new EvidenceStore();
    store.register({ id: 'ENSG1', kind: 'target', source: 'Open Targets', title: 'CDCP1', snippet: '', url: 'u', retrievedAt: 'now',
      raw: { approvedSymbol: 'CDCP1', synonyms: ['CD318'] } });
    return store;
  }

  it('does not deep-read a hit whose title lacks the target (passage-only match)', async () => {
    const search: Tool = { name: 'europepmc_search', description: '', async call() {
      return [
        { id: 'PMID:9', kind: 'publication', source: 'Europe PMC', title: 'Generic proteomics survey', snippet: '',
          passage: 'CDCP1 was among the detected proteins.', url: 'u', raw: { pmcid: 'PMC9', isOpenAccess: true }, retrievedAt: 'now' },
      ] as never;
    } };
    let fulltextCalls = 0;
    const fulltext: Tool = { name: 'pmc_fulltext', description: '', async call() { fulltextCalls++; return [] as never; } };
    const specialistModel = { async generateStructured() { return { claims: [] } as never; } };
    const verifierModel = { async generateStructured() { return { claimId: 'x', status: 'supported', rationale: '' } as never; } };

    await fillGap({
      gap: { specialistId: 'moa_pathway', question: 'q', concept: 'proteomics', reason: 'r' },
      target: 'CDCP1', tools: [search, fulltext], store: seededStore(),
      specialistModel, verifierModel, emit: () => {},
    });

    expect(fulltextCalls).toBe(0); // title-gate skipped the deep-read
  });

  it('drops off-topic full-text sections before registering', async () => {
    const search: Tool = { name: 'europepmc_search', description: '', async call() {
      return [
        { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 in pancreatic cancer', snippet: '',
          passage: 'CDCP1 is overexpressed.', url: 'u', raw: { pmcid: 'PMC1', isOpenAccess: true }, retrievedAt: 'now' },
      ] as never;
    } };
    const fulltext: Tool = { name: 'pmc_fulltext', description: '', async call() {
      return [
        { id: 'PMCID:PMC1#sec-0', kind: 'publication', source: 'PMC full text', title: 'CDCP1 signaling', snippet: '',
          passage: 'CDCP1 promotes EMT.', locator: 'CDCP1 signaling', url: 'u', raw: {}, retrievedAt: 'now' },
        { id: 'PMCID:PMC1#sec-1', kind: 'publication', source: 'PMC full text', title: 'Cohort', snippet: '',
          passage: 'Patients with MIS-C after COVID showed elevated markers.', locator: 'Cohort', url: 'u', raw: {}, retrievedAt: 'now' },
      ] as never;
    } };
    const specialistModel = { async generateStructured() { return { claims: [] } as never; } };
    const verifierModel = { async generateStructured() { return { claimId: 'x', status: 'supported', rationale: '' } as never; } };

    const store = seededStore();
    await fillGap({
      gap: { specialistId: 'moa_pathway', question: 'q', concept: 'mechanism', reason: 'r' },
      target: 'CDCP1', tools: [search, fulltext], store,
      specialistModel, verifierModel, emit: () => {},
    });

    const ids = store.all().map((e) => e.id);
    expect(ids).toContain('PMCID:PMC1#sec-0');     // on-target section registered
    expect(ids).not.toContain('PMCID:PMC1#sec-1'); // off-target MIS-C section dropped
  });
});
