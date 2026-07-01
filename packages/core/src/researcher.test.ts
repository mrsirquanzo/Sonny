import { describe, it, expect } from 'vitest';
import type { StructuredModel } from './model.js';
import { planResearchQuestions, extractClaims, type ThreadBrief, type ResearchQuestion } from './researcher.js';
import { EvidenceStore } from './evidenceStore.js';
import { runResearcher } from './researcher.js';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import type { TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { MethodologicalCritique } from '@mrsirquanzo/sonny-shared';
import { safeToolCall } from './safeToolCall.js'; // ensure import graph is wired
import { targetTerms } from './relevance.js'; // ensure import graph wired
import { buildSearchQuery } from './searchQuery.js';

const brief: ThreadBrief = {
  id: 'target_biology', title: 'Target Biology',
  objective: 'Characterize the target biology and MOA.',
  promptHint: 'Describe structure, MOA, expression.',
};

function modelReturning(value: unknown): StructuredModel {
  return { async generateStructured() { return value as never; } };
}

// A verifier model that returns an audit with no flags - the decorrelated critic.
const noFlagAudit: StructuredModel = { async generateStructured() { return { studyDesign: 'in_vitro', sampleSize: null, redFlags: [] } as never; } };

describe('planResearchQuestions', () => {
  it('returns objects with question and concept, includes target in prompt', async () => {
    let prompt = '';
    const model: StructuredModel = {
      async generateStructured(opts) {
        prompt = opts.prompt;
        return { questions: [{ question: 'What is the MOA of CDCP1?', concept: 'mechanism' }] } as never;
      },
    };
    const qs: ResearchQuestion[] = await planResearchQuestions(brief, 'CDCP1', model);
    expect(qs[0].question).toBe('What is the MOA of CDCP1?');
    expect(qs[0].concept).toBe('mechanism');
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
      { questions: [{ question: 'What is the MOA of CDCP1?', concept: 'mechanism' }] },   // plan
      { claims: [{ id: 'c1', text: 'CDCP1 promotes EMT.', citations: ['PMCID:PMC1#sec-1'], confidence: 0.8 }] }, // extract
      { done: true, followups: [], takeaway: 'CDCP1 is an EMT driver.' },                                          // reflect
    ];
    let i = 0;
    const model = { async generateStructured() { return replies[i++] as never; } };

    const events: TraceEvent[] = [];
    const findings = await runResearcher({
      brief: { id: 'target_biology', title: 'Target Biology', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: [search, fulltext], store: new EvidenceStore(),
      model, verifierModel: noFlagAudit, emit: (e) => events.push(e), budget: { maxRounds: 3 },
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
        // plan -> one question with concept; extract -> no claims; reflect -> never done, always a follow-up
        const sys = String((opts as { system?: string }).system ?? '');
        if (sys.includes('Plan the specific')) return { questions: [{ question: 'q', concept: 'kw' }] } as never;
        if (sys.includes('rigorous biomedical')) return { claims: [] } as never;
        return { done: false, followups: [{ question: 'again', concept: 'again' }], takeaway: 't' } as never;
      },
    };
    const findings = await runResearcher({
      brief: { id: 'x', title: 'X', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: [search, fulltext], store: new EvidenceStore(),
      model, verifierModel: noFlagAudit, emit: () => {}, budget: { maxRounds: 2 },
    });
    expect(findings).toBeDefined(); // returned, did not loop forever
  });

  it('does not throw when the search tool fails; the loop continues and returns findings', async () => {
    const failingSearch: Tool = { name: 'europepmc_search', description: '', async call() { throw new Error('HTTP 504'); } };
    const fulltext: Tool = { name: 'pmc_fulltext', description: '', async call() { return []; } };
    const replies = [
      { questions: [{ question: 'q?', concept: 'kw' }] }, // plan
      { claims: [] },                                          // extract (no evidence)
      { done: true, followups: [], takeaway: 'no data available' }, // reflect
    ];
    let i = 0;
    const model = { async generateStructured() { return replies[i++] as never; } };

    const findings = await runResearcher({
      brief: { id: 'x', title: 'X', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: [failingSearch, fulltext], store: new EvidenceStore(),
      model, verifierModel: noFlagAudit, emit: () => {}, budget: { maxRounds: 1 },
    });
    expect(findings.takeaway).toBe('no data available'); // completed, did not throw
  });

  it('does not deep-read a hit whose title lacks the target, but still drafts claims from abstracts', async () => {
    // Title lacks the target; passage mentions it, so it passes the search gate but must NOT be deep-read.
    const search = tool('europepmc_search', [
      { id: 'PMID:9', kind: 'publication', source: 'Europe PMC', title: 'Generic proteomics survey', snippet: '',
        passage: 'CDCP1 was among the detected proteins.', url: 'u',
        raw: { pmcid: 'PMC9', isOpenAccess: true }, retrievedAt: 'now' },
    ]);
    let fulltextCalls = 0;
    const fulltext: Tool = { name: 'pmc_fulltext', description: '', async call() { fulltextCalls++; return [] as never; } };

    const replies = [
      { questions: [{ question: 'Is CDCP1 detected?', concept: 'proteomics' }] },  // plan
      { claims: [{ id: 'c1', text: 'CDCP1 was detected.', citations: ['PMID:9'], confidence: 0.5 }] }, // extract
      { done: true, followups: [], takeaway: 't' },                                          // reflect
    ];
    let i = 0;
    const model = { async generateStructured() { return replies[i++] as never; } };

    const events: TraceEvent[] = [];
    const findings = await runResearcher({
      brief: { id: 'x', title: 'X', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: [search, fulltext], store: new EvidenceStore(),
      model, verifierModel: noFlagAudit, emit: (e) => events.push(e), budget: { maxRounds: 1 },
    });

    expect(fulltextCalls).toBe(0);                              // title-gate skipped the deep-read
    expect(events.some((e) => e.type === 'research_read')).toBe(false);
    expect(findings.claims.map((c) => c.id)).toEqual(['c1']);  // claims still drafted from the abstract
  });

  it('deep-reads a title-matching hit and drops its off-topic sections before registering', async () => {
    const search = tool('europepmc_search', [
      { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 in pancreatic cancer', snippet: '',
        passage: 'CDCP1 is overexpressed.', url: 'u',
        raw: { pmcid: 'PMC1', isOpenAccess: true }, retrievedAt: 'now' },
    ]);
    const fulltext = tool('pmc_fulltext', [
      { id: 'PMCID:PMC1#sec-0', kind: 'publication', source: 'PMC full text', title: 'CDCP1 signaling',
        snippet: '', passage: 'CDCP1 promotes EMT via SRC.', locator: 'CDCP1 signaling', url: 'u', raw: {}, retrievedAt: 'now' },
      { id: 'PMCID:PMC1#sec-1', kind: 'publication', source: 'PMC full text', title: 'Cohort characteristics',
        snippet: '', passage: 'Patients with MIS-C after COVID showed elevated markers.', locator: 'Cohort characteristics', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);

    const replies = [
      { questions: [{ question: 'What is the MOA of CDCP1?', concept: 'mechanism' }] }, // plan
      { claims: [] },                                                                             // extract
      { done: true, followups: [], takeaway: 't' },                                               // reflect
    ];
    let i = 0;
    const model = { async generateStructured() { return replies[i++] as never; } };

    const store = new EvidenceStore();
    await runResearcher({
      brief: { id: 'x', title: 'X', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: [search, fulltext], store,
      model, verifierModel: noFlagAudit, emit: () => {}, budget: { maxRounds: 1 },
    });

    const ids = store.all().map((e) => e.id);
    expect(ids).toContain('PMCID:PMC1#sec-0');     // on-target section registered
    expect(ids).not.toContain('PMCID:PMC1#sec-1'); // off-target MIS-C section dropped
  });

  it('sends the broad target AND concept query to the search tool, not the question text', async () => {
    const recordedQueries: string[] = [];
    const trackingSearch: Tool = {
      name: 'europepmc_search',
      description: 'europepmc_search',
      async call(args: Record<string, unknown>) {
        recordedQueries.push(String(args['query'] ?? ''));
        return [] as never;
      },
    };
    const fulltext: Tool = { name: 'pmc_fulltext', description: '', async call() { return [] as never; } };
    const replies = [
      { questions: [{ question: 'What is the long-winded mechanism of action question?', concept: 'mechanism' }] },
      { claims: [] },
      { done: true, followups: [], takeaway: 't' },
    ];
    let i = 0;
    const model = { async generateStructured() { return replies[i++] as never; } };

    await runResearcher({
      brief: { id: 'x', title: 'X', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: [trackingSearch, fulltext], store: new EvidenceStore(),
      model, verifierModel: noFlagAudit, emit: () => {}, budget: { maxRounds: 1 },
    });

    expect(recordedQueries).toHaveLength(1);
    expect(recordedQueries[0]).toBe(buildSearchQuery('CDCP1', 'mechanism')); // 'CDCP1 AND mechanism'
    expect(recordedQueries[0]).not.toContain('long-winded');
  });

  it('snowballs only once per thread even across multiple deep-reads', async () => {
    const search = tool('europepmc_search', [
      { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 cancer', snippet: '', passage: 'CDCP1', url: 'u', raw: { pmcid: 'PMC1', isOpenAccess: true }, retrievedAt: 'now' },
    ]);
    const fulltext = tool('pmc_fulltext', [
      { id: 'PMCID:PMC1#sec-0', kind: 'publication', source: 'PMC full text', title: 'CDCP1 sec', snippet: '', passage: 'CDCP1 promotes EMT.', locator: 'CDCP1 sec', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);
    let citeCalls = 0;
    const citations: Tool = { name: 'europepmc_citations', description: '', async call() { citeCalls++; return [] as never; } };
    const replies = [
      { questions: [{ question: 'q', concept: 'mechanism' }] },                            // plan
      { claims: [] },                                                                       // extract r1
      { done: false, followups: [{ question: 'q2', concept: 'invasion' }], takeaway: 't' }, // reflect r1
      { claims: [] },                                                                       // extract r2
      { done: true, followups: [], takeaway: 't2' },                                        // reflect r2
    ];
    let i = 0;
    const model = { async generateStructured() { return replies[i++] as never; } };
    await runResearcher({
      brief: { id: 'x', title: 'X', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: [search, fulltext, citations], store: new EvidenceStore(),
      model, verifierModel: noFlagAudit, emit: () => {}, budget: { maxRounds: 2 },
    });
    expect(citeCalls).toBe(1); // snowball fired once despite two deep-reads
  });

  it('attaches audit red flags to claims resting on audited evidence without capping confidence', async () => {
    const search = tool('europepmc_search', [
      { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 trial', snippet: '', passage: 'CDCP1', url: 'u', raw: { pmcid: 'PMC1', isOpenAccess: true }, retrievedAt: 'now' },
    ]);
    const fulltext = tool('pmc_fulltext', [
      { id: 'PMCID:PMC1#sec-0', kind: 'publication', source: 'PMC full text', title: 'CDCP1 results', snippet: '', passage: 'CDCP1 improved a surrogate marker.', locator: 'CDCP1 results', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);
    const verifierModel: StructuredModel = { async generateStructured() {
      return { studyDesign: 'post_hoc', sampleSize: 30,
        redFlags: [{ category: 'surrogate_endpoint', biasRisk: 'high', explanation: 'Surrogate marker.' }] } as never;
    } };
    const replies = [
      { questions: [{ question: 'q', concept: 'trial' }] },                                          // plan
      { claims: [{ id: 'c1', text: 'CDCP1 improved a marker.', citations: ['PMCID:PMC1#sec-0'], confidence: 0.9 }] }, // extract
      { done: true, followups: [], takeaway: 't' },                                                  // reflect
    ];
    let i = 0;
    const model = { async generateStructured() { return replies[i++] as never; } };
    const events: TraceEvent[] = [];

    const findings = await runResearcher({
      brief: { id: 'x', title: 'X', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: [search, fulltext], store: new EvidenceStore(),
      model, verifierModel, emit: (e) => events.push(e), budget: { maxRounds: 1 },
    });

    const c1 = findings.claims.find((c) => c.id === 'c1')!;
    expect(c1.confidence).toBe(0.9);                                  // NOT capped - data preserved
    expect(c1.redFlags?.[0].category).toBe('surrogate_endpoint');    // context attached
    expect(findings.critiques.some((cr) => cr.evidenceId === 'PMID:1')).toBe(true);
    expect(events.some((e) => e.type === 'methodological_critique')).toBe(true);
  });

  it('does not abort the loop when the skeptic audit throws', async () => {
    const search = tool('europepmc_search', [
      { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 trial', snippet: '', passage: 'CDCP1', url: 'u', raw: { pmcid: 'PMC1', isOpenAccess: true }, retrievedAt: 'now' },
    ]);
    const fulltext = tool('pmc_fulltext', [
      { id: 'PMCID:PMC1#sec-0', kind: 'publication', source: 'PMC full text', title: 'CDCP1 results', snippet: '', passage: 'CDCP1.', locator: 'r', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);
    const verifierModel: StructuredModel = { async generateStructured() { throw new Error('audit model down'); } };
    const replies = [
      { questions: [{ question: 'q', concept: 'trial' }] },
      { claims: [] },
      { done: true, followups: [], takeaway: 't' },
    ];
    let i = 0;
    const model = { async generateStructured() { return replies[i++] as never; } };
    const findings = await runResearcher({
      brief: { id: 'x', title: 'X', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: [search, fulltext], store: new EvidenceStore(),
      model, verifierModel, emit: () => {}, budget: { maxRounds: 1 },
    });
    expect(findings.takeaway).toBe('t'); // completed despite the audit failure
  });
});

describe('planResearchQuestions target anchoring', () => {
  it('instructs the model to emit a single concept without the target symbol', async () => {
    let system = '';
    const model = { async generateStructured(o: { system: string }) { system = o.system; return { questions: [{ question: 'q', concept: 'mechanism' }] } as never; } };
    await planResearchQuestions({ id: 'target_biology', title: 'Target Biology', objective: 'o', promptHint: 'h' }, 'CDCP1', model);
    expect(system).toContain('concept');
    expect(system.toLowerCase()).toContain('do not include the target');
  });
});

describe('runResearcher relevance gating', () => {
  it('drops search hits that do not mention the target before they reach the evidence store', async () => {
    const search: Tool = { name: 'europepmc_search', description: '', async call() {
      return [
        { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1 drives EMT', snippet: '', passage: 'CDCP1 ...', url: 'u', raw: { pmcid: '', isOpenAccess: false }, retrievedAt: 'now' },
        { id: 'PMID:2', kind: 'publication', source: 'Europe PMC', title: 'm6A methylation review', snippet: '', passage: 'METTL3 ...', url: 'u', raw: { pmcid: '', isOpenAccess: false }, retrievedAt: 'now' },
      ] as never;
    } };
    const fulltext: Tool = { name: 'pmc_fulltext', description: '', async call() { return []; } };
    const replies = [
      { questions: [{ question: 'q?', concept: 'kw' }] },
      { claims: [] },
      { done: true, followups: [], takeaway: 't' },
    ];
    let i = 0;
    const model = { async generateStructured() { return replies[i++] as never; } };
    const store = new EvidenceStore();
    await runResearcher({
      brief: { id: 'x', title: 'X', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: [search, fulltext], store, model, verifierModel: noFlagAudit, emit: () => {}, budget: { maxRounds: 1 },
    });
    // only the CDCP1 hit was registered; the off-topic m6A hit was gated out
    expect(store.has('PMID:1')).toBe(true);
    expect(store.has('PMID:2')).toBe(false);
  });
});
