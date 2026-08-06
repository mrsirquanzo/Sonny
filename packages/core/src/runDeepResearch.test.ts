import { describe, it, expect } from 'vitest';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import type { TraceEvent } from '@mrsirquanzo/sonny-shared';
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
      if (o.system.includes('Plan the specific')) return { questions: [{ question: 'q?', concept: 'kw' }] } as never;
      if (o.system.includes('rigorous biomedical')) return { claims: [{ id: 'c1', text: 'A claim citing ENSG1.', citations: ['ENSG1'], confidence: 0.8 }] } as never;
      return { done: true, followups: [], takeaway: 'takeaway' } as never; // reflect
    } };
    const verifierModel = { async generateStructured(o: { system: string }) {
      if (o.system.includes('consistency auditor')) return { contradictions: [] } as never;
      return { claimId: 'x', status: 'supported', rationale: 'ok' } as never;
    } };
    const leadModel = { async generateStructured(o: { prompt: string }) {
      if (o.prompt.includes('THREAD FINDINGS')) return { takeaway: '', claims: [] } as never;
      return { complete: true, gaps: [] } as never;
    } };

    const events: TraceEvent[] = [];
    const result = await runDeepResearch({
      target: 'CDCP1', roster, literatureTools: [search, fulltext], structuredTools: [ot],
      specialistModel, verifierModel, leadModel, emit: (e) => events.push(e), budget: { maxRounds: 1 },
    });

    expect(result.sections.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(events.some((e) => e.type === 'lead_decompose')).toBe(true);
    // Both specialists surface the same seeded fact (claim cites ENSG1); the
    // cross-section consolidation pass collapses that duplicate to one grounded claim.
    const allClaims = result.sections.flatMap((s) => s.claims);
    expect(allClaims).toHaveLength(1);
    expect(allClaims[0].citations).toContain('ENSG1');
    expect(result.weighing.claims).toEqual([]);
    // the run's evidence is surfaced for the briefing layer (references)
    expect(result.evidence.some((e) => e.id === 'ENSG1')).toBe(true);
  });
});

describe('runDeepResearch abstention', () => {
  const axisRoster: ThreadBrief[] = [
    { id: 'target_biology', title: 'Target Biology', objective: 'Assess target validity.', promptHint: 'h' },
    { id: 'moa_pathway', title: 'MOA and Pathway', objective: 'Assess modality fit.', promptHint: 'h' },
  ];

  const q1 = (claimIds: string[], validity: 'strong' | 'insufficient_evidence') => ({
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
      validity,
      confidence: validity === 'strong' ? 'moderate' : 'low',
      evidenceAvailability: validity === 'strong' ? 'rich' : 'absent',
      support: { supportingClaimIds: validity === 'strong' ? claimIds : [], evidenceIds: [] },
    }],
  });

  const q2 = (claimIds: string[]) => ({
    axis: 'moa_pathway',
    assessment: {
      modalityFit: 'strong',
      weakestLink: { mechanisticStatus: 'supported', mitigability: 'engineerable' },
      confidence: 'moderate',
      mechanisticBottleneck: 'Sustained target engagement.',
      mostDecisiveNextExperiment: 'Measure target engagement.',
      support: { supportingClaimIds: claimIds, evidenceIds: [] },
    },
  });

  async function run(q1Validity: 'strong' | 'insufficient_evidence') {
    const ot = tool('open_targets_target', [
      { id: 'ENSG1', kind: 'target', source: 'Open Targets', title: 'T', snippet: '', passage: 'tractable', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);
    const empty = tool('europepmc_search', []);
    const fulltext = tool('pmc_fulltext', []);

    const specialistModel = { async generateStructured(o: { system: string; prompt: string }) {
      if (o.system.includes('structured conclusion')) {
        const cited = [...o.prompt.matchAll(/^- \[([^\]]+)\]/gm)].map((m) => m[1]);
        return (o.system.includes('target_biology') ? q1(cited, q1Validity) : q2(cited)) as never;
      }
      if (o.system.includes('Plan the specific')) {
        return { questions: [{ question: o.prompt.includes('Target Biology') ? 'Is the target valid?' : 'Does the modality fit?', concept: 'kw' }] } as never;
      }
      if (o.system.includes('rigorous biomedical')) {
        return { claims: [{
          id: 'c1',
          text: o.prompt.includes('Is the target valid?')
            ? 'CDCP1 is over-expressed in tumour tissue.'
            : 'CDCP1 is accessible to an antibody at the cell surface.',
          citations: ['ENSG1'], confidence: 0.8,
        }] } as never;
      }
      return { done: true, followups: [], takeaway: 'takeaway' } as never;
    } };
    const verifierModel = { async generateStructured(o: { system: string }) {
      if (o.system.includes('consistency auditor')) return { contradictions: [] } as never;
      return { claimId: 'x', status: 'supported', rationale: 'ok' } as never;
    } };
    const leadModel = { async generateStructured(o: { prompt: string }) {
      if (o.prompt.includes('THREAD FINDINGS')) return { takeaway: '', claims: [] } as never;
      return { complete: true, gaps: [] } as never;
    } };

    return runDeepResearch({
      target: 'CDCP1', roster: axisRoster, literatureTools: [empty, fulltext], structuredTools: [ot],
      specialistModel, verifierModel, leadModel, emit: () => {}, budget: { maxRounds: 1 },
    });
  }

  it('proceeds when both critical axes drafted a materially covered conclusion', async () => {
    const result = await run('strong');
    // The conclusions reached the sections at all.
    expect(result.sections.map((s) => s.conclusion?.axis)).toEqual(['target_biology', 'moa_pathway']);
    expect(result.abstention).toEqual({ proceed: true, reasons: [] });
  });

  it('abstains on the conclusions, not the claim count, when a critical axis is insufficient', async () => {
    // The claim count is IDENTICAL to the proceeding run. Only Q1's conclusion
    // changed, so a raw-count gate could not tell these two runs apart.
    const proceeding = await run('strong');
    const result = await run('insufficient_evidence');
    expect(result.sections.flatMap((s) => s.claims)).toHaveLength(proceeding.sections.flatMap((s) => s.claims).length);
    expect(result.abstention.proceed).toBe(false);
    expect(result.abstention.reasons.join(' ')).toContain('target_biology');
  });
});

describe('runDeepResearch resilience', () => {
  it('turns a failing specialist into a RED placeholder and still completes', async () => {
    const ot: Tool = { name: 'open_targets_target', description: '', async call() { return []; } };
    // a search tool that throws a NON-transient error so the model-layer is reached;
    // but to force a specialist FAILURE we make the specialist model throw for brief 'b' only.
    const search: Tool = { name: 'europepmc_search', description: '', async call() { return []; } };
    const fulltext: Tool = { name: 'pmc_fulltext', description: '', async call() { return []; } };

    const roster: ThreadBrief[] = [
      { id: 'a', title: 'A', objective: 'oa', promptHint: 'ha' },
      { id: 'b', title: 'B', objective: 'ob', promptHint: 'hb' },
    ];
    // specialistModel: brief 'a' plans/extracts/reflects fine; throw when the plan prompt is for B.
    const specialistModel = { async generateStructured(o: { prompt: string; system: string }) {
      if (o.prompt.includes('TARGET: CDCP1') && o.prompt.includes('B')) throw new Error('model exploded for B');
      if (o.system.includes('Plan the specific')) return { questions: [{ question: 'q', concept: 'kw' }] } as never;
      if (o.system.includes('rigorous biomedical')) return { claims: [] } as never;
      return { done: true, followups: [], takeaway: 'ok' } as never;
    } };
    const verifierModel = { async generateStructured() { return { claimId: 'x', status: 'supported', rationale: '' } as never; } };
    const leadModel = { async generateStructured(o: { prompt: string }) {
      if (o.prompt.includes('THREAD FINDINGS')) return { takeaway: '', claims: [] } as never;
      return { complete: true, gaps: [] } as never;
    } };

    const result = await runDeepResearch({
      target: 'CDCP1', roster, literatureTools: [search, fulltext], structuredTools: [ot],
      specialistModel, verifierModel, leadModel, emit: () => {}, budget: { maxRounds: 1 },
    });

    const b = result.sections.find((s) => s.id === 'b')!;
    expect(b.rag).toBe('red');
    expect(b.takeaway).toContain('could not complete');
    expect(result.sections.find((s) => s.id === 'a')).toBeDefined(); // the healthy specialist still produced
  });

  it('degrades gracefully when completeness assessment throws - specialists work is preserved', async () => {
    const ot: Tool = { name: 'open_targets_target', description: '', async call() { return []; } };
    const search: Tool = { name: 'europepmc_search', description: '', async call() { return []; } };
    const fulltext: Tool = { name: 'pmc_fulltext', description: '', async call() { return []; } };

    const roster: ThreadBrief[] = [
      { id: 'a', title: 'A', objective: 'oa', promptHint: 'ha' },
    ];

    const specialistModel = { async generateStructured(o: { system: string }) {
      if (o.system.includes('Plan the specific')) return { questions: [{ question: 'q?', concept: 'kw' }] } as never;
      if (o.system.includes('rigorous biomedical')) return { claims: [] } as never;
      return { done: true, followups: [], takeaway: 'done' } as never;
    } };
    const verifierModel = { async generateStructured() { return { claimId: 'x', status: 'supported', rationale: '' } as never; } };
    // completeness prompt contains 'SECTIONS:'; weighing prompt contains 'THREAD FINDINGS'
    const leadModel = { async generateStructured(o: { prompt: string }) {
      if (o.prompt.includes('THREAD FINDINGS')) return { takeaway: '', claims: [] } as never;
      throw new Error('lead model exploded on completeness');
    } };

    const events: TraceEvent[] = [];
    const result = await runDeepResearch({
      target: 'CDCP1', roster, literatureTools: [search, fulltext], structuredTools: [ot],
      specialistModel, verifierModel, leadModel, emit: (e) => events.push(e), budget: { maxRounds: 1 },
    });

    // must resolve (not throw) and return the specialist's section
    expect(result.sections.map((s) => s.id)).toEqual(['a']);
    // specialist succeeded, so section should not be a placeholder
    expect(result.sections[0].takeaway).not.toContain('could not complete');
    // weighing must be present (gracefully degraded completeness, then weighing ran)
    expect(result.weighing).toBeDefined();
    // error event for completeness failure should have been emitted
    expect(events.some((e) => e.type === 'error' && e.message.includes('completeness assessment failed'))).toBe(true);
  });
});
