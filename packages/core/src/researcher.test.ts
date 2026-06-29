import { describe, it, expect } from 'vitest';
import type { StructuredModel } from './model.js';
import { planResearchQuestions, extractClaims, type ThreadBrief } from './researcher.js';
import { EvidenceStore } from './evidenceStore.js';
import { runResearcher } from './researcher.js';
import type { Tool } from '@sonny/mcp-gateway';
import type { TraceEvent } from '@sonny/shared';

const brief: ThreadBrief = {
  id: 'target_biology', title: 'Target Biology',
  objective: 'Characterize the target biology and MOA.',
  promptHint: 'Describe structure, MOA, expression.',
};

function modelReturning(value: unknown): StructuredModel {
  return { async generateStructured() { return value as never; } };
}

describe('planResearchQuestions', () => {
  it('returns the planned questions and includes the target in the prompt', async () => {
    let prompt = '';
    const model: StructuredModel = {
      async generateStructured(opts) { prompt = opts.prompt; return { questions: ['What is the MOA of CDCP1?'] } as never; },
    };
    const qs = await planResearchQuestions(brief, 'CDCP1', model);
    expect(qs).toEqual(['What is the MOA of CDCP1?']);
    expect(prompt).toContain('CDCP1');
    expect(prompt).toContain('Target Biology');
  });
});

describe('extractClaims', () => {
  it('returns claims as drafted by the model', async () => {
    const model = modelReturning({ claims: [
      { id: 'c1', text: 'CDCP1 drives EMT.', citations: ['PMCID:PMC1#sec-1'], confidence: 0.8 },
    ] });
    const claims = await extractClaims('What is the MOA?', '[PMCID:PMC1#sec-1] (Results) ...', model);
    expect(claims).toHaveLength(1);
    expect(claims[0].citations).toEqual(['PMCID:PMC1#sec-1']);
  });
});

function tool(name: string, evidence: object[]): Tool {
  return { name, description: name, async call() { return evidence as never; } };
}

describe('runResearcher loop', () => {
  it('plans, reads full text, extracts grounded claims, reflects, and stops when done', async () => {
    const search = tool('europepmc_search', [
      { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1', snippet: '',
        passage: 'abstract', url: 'u', raw: { pmcid: 'PMC1', isReview: false, isOpenAccess: true }, retrievedAt: 'now' },
    ]);
    const fulltext = tool('pmc_fulltext', [
      { id: 'PMCID:PMC1#sec-1', kind: 'publication', source: 'PMC full text', title: 'Results',
        snippet: 'Results', passage: 'CDCP1 promotes EMT.', locator: 'Results', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);

    const replies = [
      { questions: ['What is the MOA of CDCP1?'] },                                   // plan
      { claims: [{ id: 'c1', text: 'CDCP1 promotes EMT.', citations: ['PMCID:PMC1#sec-1'], confidence: 0.8 }] }, // extract
      { done: true, followups: [], takeaway: 'CDCP1 is an EMT driver.' },             // reflect
    ];
    let i = 0;
    const model = { async generateStructured() { return replies[i++] as never; } };

    const events: TraceEvent[] = [];
    const findings = await runResearcher({
      brief: { id: 'target_biology', title: 'Target Biology', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: [search, fulltext], store: new EvidenceStore(),
      model, emit: (e) => events.push(e), budget: { maxRounds: 3 },
    });

    expect(findings.takeaway).toBe('CDCP1 is an EMT driver.');
    expect(findings.claims.map((c) => c.id)).toEqual(['c1']);
    expect(events.map((e) => e.type)).toContain('research_plan');
    expect(events.map((e) => e.type)).toContain('research_read');
    expect(events.map((e) => e.type)).toContain('research_reflect');
  });

  it('always halts at maxRounds even if the model never says done', async () => {
    const search = tool('europepmc_search', [
      { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'x', snippet: '',
        passage: 'a', url: 'u', raw: { pmcid: 'PMC1' }, retrievedAt: 'now' },
    ]);
    const fulltext = tool('pmc_fulltext', [
      { id: 'PMCID:PMC1#sec-0', kind: 'publication', source: 'PMC full text', title: 'S',
        snippet: 'S', passage: 'p', locator: 'S', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);
    const model = {
      async generateStructured(opts: { schema: { safeParse?: unknown } }) {
        // plan -> one question; extract -> no claims; reflect -> never done, always a follow-up
        const sys = String((opts as { system?: string }).system ?? '');
        if (sys.includes('Plan the specific')) return { questions: ['q'] } as never;
        if (sys.includes('rigorous biomedical')) return { claims: [] } as never;
        return { done: false, followups: ['again'], takeaway: 't' } as never;
      },
    };
    const findings = await runResearcher({
      brief: { id: 'x', title: 'X', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: [search, fulltext], store: new EvidenceStore(),
      model, emit: () => {}, budget: { maxRounds: 2 },
    });
    expect(findings).toBeDefined(); // returned, did not loop forever
  });
});
