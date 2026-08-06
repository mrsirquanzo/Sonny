import { describe, it, expect } from 'vitest';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import type { Evidence, RetrievalAudit, TraceEvent } from '@mrsirquanzo/sonny-shared';
import { RetrievalAuditStore } from '@mrsirquanzo/sonny-shared';
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
      { questions: [{ question: 'What is the MOA?', concept: 'mechanism' }] },
      { claims: [{ id: 'c1', text: 'CDCP1 promotes EMT.', citations: ['PMCID:PMC1#sec-1'], confidence: 0.8 }] },
      { done: true, followups: [], takeaway: 'mid-research note, never shipped' },
      // The section takeaway, written after verification from the supported claims.
      { takeaway: 'CDCP1 drives EMT.' },
    ];
    let i = 0;
    const specialistModel = { async generateStructured() { return specialistReplies[i++] as never; } };
    const verifierModel = { async generateStructured(opts: { system: string }) {
      return (opts.system.includes('SENTENCE')
        ? { entailed: true, rationale: 'ok' }
        : { claimId: 'x', status: 'supported', rationale: 'ok' }) as never;
    } };

    const events: TraceEvent[] = [];
    const section = await produceResearchSection({
      brief: { id: 'target_biology', title: 'Target Biology', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: [search, fulltext], store: new EvidenceStore(),
      specialistModel, verifierModel, emit: (e) => events.push(e), budget: { maxRounds: 2 },
    });

    expect(section.id).toBe('target_biology');
    expect(section.takeaway).toBe('CDCP1 drives EMT.');
    expect(section.claims.map((c) => c.id)).toEqual(['target_biology#r0c1']);
    expect(section.sources).toContain('PMCID:PMC1#sec-1');
    expect(section.rag).toBe('amber'); // one supported claim, single source -> amber
    expect(events.some((e) => e.type === 'section_complete')).toBe(true);
    expect(Array.isArray(section.critiques)).toBe(true);
  });
});

// ---------------------------------------------------------------- conclusions

const card = (id: string, snippet: string): Evidence => ({
  id, kind: 'target', source: 'Open Targets', title: id, snippet,
  url: 'u', raw: {}, retrievedAt: '2026-08-05T00:00:00.000Z',
});

const literatureTools = (passage: string): Tool[] => [
  // The title must name the target: it gates the deep read, and a hit that
  // reads as irrelevant sends retrieval back to the model to widen the query,
  // which would put an unscripted call in the middle of these fixtures.
  tool('europepmc_search', [
    { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'CDCP1', snippet: '',
      passage: 'abstract', url: 'u', raw: { pmcid: 'PMC1', isOpenAccess: true }, retrievedAt: 'now' },
  ]),
  tool('pmc_fulltext', [
    { id: 'PMCID:PMC1#sec-1', kind: 'publication', source: 'PMC full text', title: 'Results',
      snippet: 'Results', passage, locator: 'Results', url: 'u', raw: {}, retrievedAt: 'now' },
  ]),
];

/**
 * A scripted specialist. The last reply is the conclusion draft, so the call
 * count itself proves the drafter ran exactly once per section.
 */
function scriptedSpecialist(replies: unknown[]) {
  const seen: string[] = [];
  let i = 0;
  return {
    seen,
    model: {
      async generateStructured(opts: { system: string; prompt: string }) {
        seen.push(`${opts.system}\n${opts.prompt}`);
        return replies[i++] as never;
      },
    },
  };
}

const supportedVerifier = {
  async generateStructured() { return { claimId: 'x', status: 'supported', rationale: 'ok' } as never; },
};

const audit = (id: string, sourceId: string, queryClass: string): RetrievalAudit => ({
  id,
  axis: 'modality_developability',
  // The key `runResearcher` records under. A conclusion looking anywhere else
  // finds an empty bucket.
  sectionKey: 'modality_developability',
  sourceId: sourceId as RetrievalAudit['sourceId'],
  queryClass: queryClass as RetrievalAudit['queryClass'],
  queryFingerprint: `${sourceId}-${queryClass}`,
  normalizedQueryTerms: ['CDCP1'],
  status: 'completed',
  executedAt: '2026-08-05T00:00:00.000Z',
  rawResultCount: 4,
  relevantResultCount: 2,
});

const support = (claimIds: string[], auditIds?: string[]) => ({
  supportingClaimIds: claimIds,
  evidenceIds: [],
  ...(auditIds ? { retrievalAuditIds: auditIds } : {}),
});

const lowQ6 = (claimIds: string[], auditIds: string[]) => ({
  axis: 'modality_developability',
  assessment: {
    overallDevelopmentRisk: 'low',
    liabilities: [],
    domainAssessments: [
      { domain: 'safety', status: 'no_material_liability', confidence: 'moderate', support: support(claimIds) },
      { domain: 'pk_pd', status: 'manageable', confidence: 'moderate', support: support(claimIds) },
    ],
    topProgrammeKillingRiskIds: [],
    highestPriorityRiskMitigationOrMonitoringStep: 'Monitor liver enzymes in first-in-human.',
    earliestDecisiveDeRiskingStudy: 'A 28-day rat tox study.',
    confidence: 'moderate',
    support: support(claimIds, auditIds),
  },
});

/**
 * Dispatching stub rather than a fixed script. Q6 retrieval can spend an extra
 * model call widening a query, and a positional script would then hand the
 * conclusion to the wrong caller and fail for a reason that has nothing to do
 * with what these tests assert.
 */
function q6Specialist(conclusionFor: (claimIds: string[]) => unknown) {
  const seen: string[] = [];
  return {
    seen,
    model: {
      async generateStructured(opts: { system: string; prompt: string }) {
        const text = `${opts.system}\n${opts.prompt}`;
        seen.push(text);
        if (opts.system.includes('structured conclusion')) {
          // Cite whatever the drafter was actually shown. Hard-coding an id
          // would test the id-numbering scheme, not the wiring.
          const cited = [...opts.prompt.matchAll(/^- \[([^\]]+)\]/gm)].map((m) => m[1]);
          return conclusionFor(cited) as never;
        }
        if (opts.prompt.startsWith('RESEARCH QUESTION:')) {
          return { claims: [{ id: 'c1', text: 'CDCP1 showed no hepatotoxicity signal.', citations: ['PMCID:PMC1#sec-1'], confidence: 0.8 }] } as never;
        }
        if (text.includes('CLAIMS SO FAR')) {
          return { done: true, followups: [], takeaway: 'Liabilities look manageable.' } as never;
        }
        return { questions: [{ question: 'What are the liabilities?', concept: 'safety' }] } as never;
      },
    },
  };
}

async function runQ6(opts: { modality?: 'small_molecule'; auditStore: RetrievalAuditStore; store: EvidenceStore }) {
  const specialist = q6Specialist((claimIds) => lowQ6(claimIds, ['audit-epmc', 'audit-ot']));
  const section = await produceResearchSection({
    brief: { id: 'modality_developability', title: 'Modality & Developability', objective: 'o', promptHint: 'h' },
    target: 'CDCP1',
    // The passage must name the target: `relevanceGate` drops full-text
    // sections that do not, and a dropped passage means nothing to cite.
    tools: literatureTools('CDCP1 showed no hepatotoxicity signal.'),
    store: opts.store,
    specialistModel: specialist.model,
    verifierModel: supportedVerifier,
    emit: () => {},
    budget: { maxRounds: 2 },
    auditStore: opts.auditStore,
    ...(opts.modality ? { modality: opts.modality } : {}),
  });
  return { section, specialist };
}

function q6AuditStore(): RetrievalAuditStore {
  const auditStore = new RetrievalAuditStore();
  auditStore.register(audit('audit-epmc', 'europepmc', 'safety_class'));
  auditStore.register(audit('audit-ot', 'opentargets', 'target_modality'));
  return auditStore;
}

describe('produceResearchSection conclusions', () => {
  it('drafts the conclusion from the shipped claim set plus the cards routed to this axis', async () => {
    const store = new EvidenceStore();
    store.register(card('ENSG1#domains', 'CDCP1 carries a CUB domain.'));       // routed to target_biology
    store.register(card('ENSG1#safety', 'A hepatic safety signal is recorded.')); // routed elsewhere

    const conclusion = {
      axis: 'target_biology',
      assessments: [{
        context: {
          canonicalContextId: 'context-1', ontologySource: 'MONDO', ontologyVersion: '2026-06-02',
          indication: { raw: 'NSCLC', canonicalName: 'non-small cell lung carcinoma' },
          mappingConfidence: 'exact',
        },
        q1HypothesisKey: 'CDCP1|disease_driver|suppress_function',
        target: { kind: 'gene_or_protein', symbol: 'CDCP1' },
        targetRole: 'disease_driver',
        biologicalIntent: 'suppress_function',
        validity: 'strong',
        confidence: 'moderate',
        evidenceAvailability: 'rich',
        support: { supportingClaimIds: ['target_biology#r0c1', 'struct-1'], evidenceIds: ['MODEL_INVENTED'] },
      }],
    };

    const specialist = scriptedSpecialist([
      { questions: [{ question: 'What is the MOA?', concept: 'mechanism' }] },
      { claims: [{ id: 'c1', text: 'CDCP1 promotes EMT.', citations: ['PMCID:PMC1#sec-1'], confidence: 0.8 }] },
      { done: true, followups: [], takeaway: 'CDCP1 drives EMT.' },
      { takeaway: 'CDCP1 promotes EMT.' },
      conclusion,
    ]);

    const section = await produceResearchSection({
      brief: { id: 'target_biology', title: 'Target Biology', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: literatureTools('CDCP1 promotes EMT.'), store,
      specialistModel: specialist.model, verifierModel: supportedVerifier,
      emit: () => {}, budget: { maxRounds: 2 },
    });

    // The conclusion reaches the section.
    expect(section.kind).toBe('research');
    expect(section.conclusion).toBeDefined();
    expect(section.conclusion?.axis).toBe('target_biology');

    // Drafted exactly once, after research and verification.
    expect(specialist.seen).toHaveLength(5);
    const draftInput = specialist.seen[4];

    // The SAME set that builds section.claims.
    expect(section.claims.map((c) => c.id)).toEqual(['target_biology#r0c1']);
    expect(draftInput).toContain('target_biology#r0c1');

    // Plus the deterministic cards routed to THIS axis, and only those.
    expect(draftInput).toContain('CUB domain');
    expect(draftInput).not.toContain('hepatic safety signal');

    // Support was resolved, not accepted: evidence ids are derived from the
    // cited claims, never authored by the model.
    if (section.conclusion?.axis !== 'target_biology') throw new Error('unexpected axis');
    const resolved = section.conclusion.assessments[0].support;
    expect(resolved.supportingClaimIds).toContain('target_biology#r0c1');
    expect(resolved.evidenceIds).not.toContain('MODEL_INVENTED');
    expect(resolved.evidenceIds).toContain('PMCID:PMC1#sec-1');

    // Legacy shape: no schemaVersion. `parseStoredSection` dispatches on its
    // presence, and these sections carry no scope for V2 to validate.
    expect('schemaVersion' in section).toBe(false);
  });

  it('never shows the drafter a claim the verifier rejected', async () => {
    const rejectingVerifier = {
      async generateStructured() { return { claimId: 'x', status: 'unsupported', rationale: 'no' } as never; },
    };
    const specialist = scriptedSpecialist([
      { questions: [{ question: 'What is the MOA?', concept: 'mechanism' }] },
      { claims: [{ id: 'c1', text: 'CDCP1 cures everything.', citations: ['PMCID:PMC1#sec-1'], confidence: 0.8 }] },
      { done: true, followups: [], takeaway: 'thin.' },
      { axis: 'clinical_landscape', assessment: { precedent: 'insufficient_evidence', confidence: 'low', support: { supportingClaimIds: [], evidenceIds: [] } } },
    ]);

    const section = await produceResearchSection({
      brief: { id: 'clinical_landscape', title: 'Clinical Landscape', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: literatureTools('CDCP1 cures everything.'), store: new EvidenceStore(),
      specialistModel: specialist.model, verifierModel: rejectingVerifier,
      emit: () => {}, budget: { maxRounds: 2 },
    });

    expect(section.claims).toEqual([]);
    // Index 3, not 4: with zero supported claims the takeaway writer
    // short-circuits to a stated degradation without a model call, so the
    // conclusion draft is the fourth call here and the fifth elsewhere.
    expect(specialist.seen[3]).not.toContain('cures everything');
    expect(section.conclusion?.axis).toBe('clinical_landscape');
  });

  it('keeps a researched section when the conclusion draft fails', async () => {
    const specialist = {
      calls: 0,
      async generateStructured() {
        this.calls++;
        if (this.calls === 1) return { questions: [{ question: 'q', concept: 'c' }] } as never;
        if (this.calls === 2) return { claims: [{ id: 'c1', text: 'CDCP1 promotes EMT.', citations: ['PMCID:PMC1#sec-1'], confidence: 0.8 }] } as never;
        if (this.calls === 3) return { done: true, followups: [], takeaway: 'CDCP1 drives EMT.' } as never;
        // Call 4 is the section-takeaway writer, which has its own degradation
        // path. Only call 5, the conclusion draft, is the failure under test.
        if (this.calls === 4) return { takeaway: 'CDCP1 promotes EMT.' } as never;
        throw new Error('drafter unavailable');
      },
    };
    const events: TraceEvent[] = [];
    const section = await produceResearchSection({
      brief: { id: 'target_biology', title: 'Target Biology', objective: 'o', promptHint: 'h' },
      target: 'CDCP1', tools: literatureTools('CDCP1 promotes EMT.'), store: new EvidenceStore(),
      specialistModel: specialist, verifierModel: supportedVerifier,
      emit: (e) => events.push(e), budget: { maxRounds: 2 },
    });

    expect(section.claims.map((c) => c.id)).toEqual(['target_biology#r0c1']);
    expect(section.conclusion).toBeUndefined();
    expect(events.some((e) => e.type === 'error' && e.message.includes('drafter unavailable'))).toBe(true);
  });

  it('lets a low Q6 stand when the run threads its modality through', async () => {
    const { section, specialist } = await runQ6({ modality: 'small_molecule', auditStore: q6AuditStore(), store: new EvidenceStore() });
    if (section.conclusion?.axis !== 'modality_developability') throw new Error('unexpected axis');
    // Guard against a vacuous pass: a low Q6 with no supporting claims degrades
    // for that reason alone, which would hide whether the modality mattered.
    expect(section.claims).toHaveLength(1);
    expect(specialist.seen.at(-1)).toContain(section.claims[0].id);
    expect(section.conclusion.assessment.overallDevelopmentRisk).toBe('low');
  });

  it('degrades the same low Q6 when no modality reaches the validator', async () => {
    // The fail-closed path. Nothing about the evidence changed; only the
    // modality is missing, so the critical risk domains cannot be established.
    const { section } = await runQ6({ auditStore: q6AuditStore(), store: new EvidenceStore() });
    if (section.conclusion?.axis !== 'modality_developability') throw new Error('unexpected axis');
    expect(section.conclusion.assessment.overallDevelopmentRisk).toBe('insufficient_evidence');
  });

  it('degrades a low Q6 whose retrieval audits are not in this section bucket', async () => {
    // Same conclusion, audits recorded under another section. Absence is a
    // claim about THIS question.
    const auditStore = new RetrievalAuditStore();
    auditStore.register({ ...audit('audit-epmc', 'europepmc', 'safety_class'), sectionKey: 'somewhere_else' });
    auditStore.register({ ...audit('audit-ot', 'opentargets', 'target_modality'), sectionKey: 'somewhere_else' });
    const { section } = await runQ6({ modality: 'small_molecule', auditStore, store: new EvidenceStore() });
    if (section.conclusion?.axis !== 'modality_developability') throw new Error('unexpected axis');
    expect(section.conclusion.assessment.overallDevelopmentRisk).toBe('insufficient_evidence');
  });
});
