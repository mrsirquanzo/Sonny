import { describe, it, expect, vi } from 'vitest';
import type { Section, Claim, Evidence, ContradictionFlag, SpecialistConclusion } from '@mrsirquanzo/sonny-shared';
import type { StructuredModel } from './model.js';
import { synthesizeRecommendation } from './synthesize.js';

/**
 * The run's abstention verdict is an INPUT to synthesis, so tests about the
 * memo itself state it rather than construct sections that happen to satisfy
 * the gate. The gate's own behaviour is exercised below, on real conclusions.
 */
const PROCEED = { proceed: true, reasons: [] };

const q1Covered: SpecialistConclusion = {
  axis: 'target_biology',
  assessments: [{
    context: {
      canonicalContextId: 'context-1',
      ontologySource: 'MONDO',
      ontologyVersion: '2026-06-02',
      indication: { raw: 'NSCLC', canonicalName: 'non-small cell lung carcinoma', ontologyId: 'MONDO:0005233' },
      mappingConfidence: 'exact',
      mappingRelation: 'exact',
    },
    q1HypothesisKey: 'EGFR|disease_driver|suppress_function',
    target: { kind: 'gene_or_protein', symbol: 'EGFR' },
    targetRole: 'disease_driver',
    biologicalIntent: 'suppress_function',
    validity: 'strong',
    confidence: 'moderate',
    evidenceAvailability: 'rich',
    support: { supportingClaimIds: ['m1'], evidenceIds: ['PMID:1'] },
  }],
};

const q2Covered: SpecialistConclusion = {
  axis: 'moa_pathway',
  assessment: {
    modalityFit: 'strong',
    weakestLink: { mechanisticStatus: 'supported', mitigability: 'engineerable' },
    confidence: 'moderate',
    mechanisticBottleneck: 'Sustained target engagement.',
    mostDecisiveNextExperiment: 'Measure target engagement.',
    support: { supportingClaimIds: ['m2'], evidenceIds: ['PMID:1'] },
  },
};

const q2Insufficient: SpecialistConclusion = {
  axis: 'moa_pathway',
  assessment: {
    modalityFit: 'insufficient_evidence',
    confidence: 'low',
    evidenceGap: 'No modality-feasibility evidence.',
    support: { supportingClaimIds: [], evidenceIds: [] },
  },
};

const sections: Section[] = [
  { kind: 'research', id: 'moa_pathway', title: 'MOA & Pathway', takeaway: 'Strong mechanism.',
    claims: [
      { id: 'c1', text: 'Drives EMT.', citations: ['PMID:1'], confidence: 0.8 },
      { id: 'c2', text: 'Promotes invasion.', citations: ['PMID:1'], confidence: 0.8 },
    ], sources: ['PMID:1'], rag: 'green' },
];
const weighing = { takeaway: 'Mechanism strong, genetics weak.', claims: [
  { id: 'w1', text: 'Mechanism outweighs weak genetics.', citations: ['PMID:1'], confidence: 0.7 } as Claim,
] };
const evidence: Evidence[] = [
  { id: 'PMID:1', kind: 'publication', source: 'Europe PMC', title: 'P', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' },
];

/**
 * A model that answers the writer call with `draft` and every prose-entailment
 * call with `entailed`.
 *
 * The narrative gate runs one judge call per sentence of framing, bottom line,
 * executive read, and each condition, so a single-shape mock would feed the
 * writer's own draft back as a verdict and fail closed on every sentence.
 */
function synthModel(
  draft: unknown,
  opts: { entailed?: boolean; onWrite?: (o: { prompt: string; system: string }) => void } = {},
): StructuredModel {
  return {
    async generateStructured(o) {
      if (o.system.includes('SENTENCE')) return { entailed: opts.entailed !== false, rationale: '' } as never;
      opts.onWrite?.({ prompt: o.prompt, system: o.system });
      return draft as never;
    },
  };
}

describe('synthesizeRecommendation', () => {
  it('produces a recommendation from verified claims and drops phantom citations', async () => {
    let prompt = '';
    const model = synthModel({
      verdict: 'watch', thesis: 'Mechanistically interesting, under-validated.',
      framing: 'CDCP1 drives EMT but is genetically thin.',
      bull: [{ point: 'Strong mechanism.', citations: ['PMID:1', 'PMID:999'] }], // PMID:999 is phantom
      bear: [{ point: 'Weak genetics.', citations: ['PMID:1'] }],
      bottomLine: 'The mechanism carries the case.',
      conditions: ['A positive Phase 1 readout moves to GO.'],
      executiveRead: 'CDCP1 is mechanistically compelling but genetically thin.',
    }, { onWrite: (o) => { prompt = o.prompt; } });
    const { recommendation, executiveRead } = await synthesizeRecommendation({ target: 'CDCP1', sections, weighing, evidence, model, abstention: PROCEED });
    expect(recommendation.verdict).toBe('watch');
    // phantom citation dropped, real one kept
    expect(recommendation.bull[0].citations).toEqual(['PMID:1']);
    expect(executiveRead).toContain('mechanistically');
    // synthesizer saw the verified claims, not raw evidence text
    expect(prompt).toContain('Drives EMT.');
    expect(prompt).toContain('Mechanism outweighs weak genetics.');
  });

  it('passes moderate/high audit caveats to the writer and instructs surfacing them', async () => {
    let prompt = '';
    let system = '';
    const model = synthModel(
      { verdict: 'watch', thesis: 't', framing: 'f', bull: [], bear: [], bottomLine: 'bl', conditions: [], executiveRead: 'er' },
      { onWrite: (o) => { prompt = o.prompt; system = o.system; } },
    );
    const sections = [{
      kind: 'research', id: 'a', title: 'A', takeaway: 'tk', rag: 'amber', sources: ['PMID:1'],
      claims: [
        { id: 'c1', text: 'eGFR improved.', citations: ['PMID:1'], confidence: 0.9,
          redFlags: [{ category: 'surrogate_endpoint', biasRisk: 'high', explanation: 'unpowered post-hoc subgroup' }] },
        { id: 'c2', text: 'Minor effect.', citations: ['PMID:1'], confidence: 0.5,
          redFlags: [{ category: 'unblinded', biasRisk: 'low', explanation: 'open label' }] },
      ],
    }];
    await synthesizeRecommendation({
      target: 'FOO', sections: sections as never, weighing: { takeaway: '', claims: [] },
      evidence: [{ id: 'PMID:1', kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' }] as never,
      model, abstention: PROCEED,
    });
    expect(prompt).toContain('unpowered post-hoc subgroup'); // high flag surfaced to the writer
    expect(prompt).not.toContain('open label');              // low flag not surfaced
    expect(system.toLowerCase()).toContain('audit');         // writer instructed to weave the caveat
  });

  it('forces NO-GO when any section carries a severe developability risk, even on a go draft', async () => {
    let prompt = '';
    const model = synthModel(
      { verdict: 'go', thesis: 'strong biology', framing: 'f', bull: [], bear: [], bottomLine: 'bl', conditions: [], executiveRead: 'er' },
      { onWrite: (o) => { prompt = o.prompt; } },
    );
    const sections = [
      { kind: 'research', id: 'target_biology', title: 'Target Biology', takeaway: 'great', rag: 'green', sources: ['PMID:1'], claims: [
        { id: 'b1', text: 'Expressed in tumor.', citations: ['PMID:1'], confidence: 0.9 },
        { id: 'b2', text: 'Correlates with stage.', citations: ['PMID:1'], confidence: 0.9 },
      ] },
      { kind: 'research', id: 'modality_developability', title: 'Modality & Developability', takeaway: 'tough', rag: 'red', sources: ['PMID:9'], claims: [],
        developabilityRisks: [{ evidenceId: 'PMID:9', category: 'immunogenicity', severity: 'severe', explanation: 'High ADA incidence.' }] },
    ];
    const { recommendation } = await synthesizeRecommendation({
      target: 'HARD', sections: sections as never, weighing: { takeaway: '', claims: [] },
      evidence: [{ id: 'PMID:9', kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' }] as never,
      model, abstention: PROCEED,
    });
    expect(recommendation.verdict).toBe('no-go');          // severe developability overrides the go draft
    expect(prompt).toContain('High ADA incidence.');       // risk surfaced to the writer
  });

  it('does not override the verdict for a significant-only developability risk', async () => {
    const model = synthModel({ verdict: 'go', thesis: 't', framing: 'f', bull: [], bear: [], bottomLine: 'bl', conditions: [], executiveRead: 'er' });
    const sections = [
      { kind: 'research', id: 'modality_developability', title: 'M', takeaway: 't', rag: 'amber', sources: ['PMID:9'], claims: [
        { id: 'm1', text: 'Feasible format.', citations: ['PMID:9'], confidence: 0.8 },
        { id: 'm2', text: 'Manufacturable.', citations: ['PMID:9'], confidence: 0.8 },
      ], developabilityRisks: [{ evidenceId: 'PMID:9', category: 'half_life', severity: 'significant', explanation: 'Short half-life.' }] },
    ];
    const { recommendation } = await synthesizeRecommendation({
      target: 'FOO', sections: sections as never, weighing: { takeaway: '', claims: [] },
      evidence: [{ id: 'PMID:9', kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' }] as never,
      model, abstention: PROCEED,
    });
    expect(recommendation.verdict).toBe('go');             // significant informs but does not override
  });
});

function section(id: string, claimCount: number, conclusion?: SpecialistConclusion): Section {
  return {
    kind: 'research', id, title: id, takeaway: 't',
    claims: Array.from({ length: claimCount }, (_, i) => ({
      id: `${id}-c${i}`, text: 'a finding', citations: ['PMID:1'], confidence: 0.9,
    })),
    sources: [], rag: claimCount ? 'amber' : 'red',
    ...(conclusion ? { conclusion } : {}),
  };
}

const abstentionEvidence: Evidence[] = [{
  id: 'PMID:1', kind: 'publication', source: 's', title: 't', snippet: 's',
  url: 'u', raw: {}, retrievedAt: 'now',
}];

const abstentionDraft = {
  verdict: 'watch', thesis: 'th',
  bull: [{ point: 'b', citations: ['PMID:1'] }],
  bear: [{ point: 'x', citations: [] }],
  conditions: [], executiveRead: 'exec',
};

describe('synthesizeRecommendation abstention gate', () => {
  it('abstains on zero supported claims and never calls the model', async () => {
    const gen = vi.fn();
    const { recommendation, executiveRead } = await synthesizeRecommendation({
      target: 'ZXQR7', sections: [section('a', 0), section('b', 0)],
      weighing: { takeaway: '', claims: [] }, evidence: [], model: { generateStructured: gen } as any,
    });
    expect(recommendation.verdict).toBe('insufficient-evidence');
    expect(recommendation.bull).toEqual([]);
    expect(recommendation.bear).toEqual([]);
    expect(recommendation.conditions).toEqual([]);
    expect(recommendation.thesis).toContain('ZXQR7');
    expect(executiveRead).toContain('ZXQR7');
    expect(gen).not.toHaveBeenCalled();
  });

  it('abstains on exactly one supported claim (the single-finding gap)', async () => {
    const gen = vi.fn();
    const { recommendation } = await synthesizeRecommendation({
      target: 'FOO', sections: [section('a', 1), section('b', 0)],
      weighing: { takeaway: '', claims: [] }, evidence: abstentionEvidence, model: { generateStructured: gen } as any,
    });
    expect(recommendation.verdict).toBe('insufficient-evidence');
    expect(gen).not.toHaveBeenCalled();
  });

  it('abstains when the only claims are deterministic curated cards', async () => {
    // Regression: curated Open Targets/UniProt cards are merged into
    // section.claims AFTER verification, carrying an assigned 0.9 confidence
    // rather than a verifier verdict. Two of them must not clear the gate on a
    // target whose model-generated claims all failed verification.
    const gen = vi.fn();
    const cardsOnly: Section = {
      kind: 'research', id: 'target_biology', title: 'T', takeaway: 't',
      claims: [
        { id: 's1', text: 'Subcellular location: cell membrane.', citations: ['ENSG1#localization'], confidence: 0.9, provenance: 'deterministic' },
        { id: 's2', text: 'Highest normal expression in pancreas.', citations: ['ENSG1#expression'], confidence: 0.9, provenance: 'deterministic' },
      ],
      sources: ['ENSG1#localization', 'ENSG1#expression'], rag: 'red',
    } as never;
    const { recommendation } = await synthesizeRecommendation({
      target: 'ZXQR7', sections: [cardsOnly],
      weighing: { takeaway: '', claims: [] }, evidence: abstentionEvidence, model: { generateStructured: gen } as any,
    });
    expect(recommendation.verdict).toBe('insufficient-evidence');
    expect(gen).not.toHaveBeenCalled();
  });

  it('counts verified model claims alongside deterministic cards', async () => {
    // One deterministic card plus two verified findings still proceeds: the
    // gate excludes cards from the count, it does not reject sections holding them.
    const gen = vi.fn().mockResolvedValue(abstentionDraft);
    const mixed: Section = {
      kind: 'research', id: 'target_biology', title: 'T', takeaway: 't',
      claims: [
        { id: 's1', text: 'card', citations: ['ENSG1#localization'], confidence: 0.9, provenance: 'deterministic' },
        { id: 'm1', text: 'a finding', citations: ['PMID:1'], confidence: 0.8 },
        { id: 'm2', text: 'another finding', citations: ['PMID:1'], confidence: 0.8 },
      ],
      sources: ['PMID:1'], rag: 'amber', conclusion: q1Covered,
    } as never;
    const { recommendation } = await synthesizeRecommendation({
      target: 'EGFR', sections: [mixed, section('moa_pathway', 0, q2Covered)],
      weighing: { takeaway: '', claims: [] }, evidence: abstentionEvidence, model: { generateStructured: gen } as any,
    });
    expect(recommendation.verdict).not.toBe('insufficient-evidence');
    expect(gen).toHaveBeenCalled();
  });

  it('takes the normal path when both critical axes reached a conclusion', async () => {
    // Counts WRITER calls: the narrative gate adds one judge call per prose
    // sentence, so a raw call count no longer reads as "the memo was written once".
    const writes = vi.fn();
    const model = synthModel(abstentionDraft, { onWrite: writes });
    const { recommendation } = await synthesizeRecommendation({
      target: 'EGFR',
      sections: [section('target_biology', 2, q1Covered), section('moa_pathway', 0, q2Covered)],
      weighing: { takeaway: '', claims: [] }, evidence: abstentionEvidence, model,
    });
    expect(writes).toHaveBeenCalledOnce();
    expect(recommendation.verdict).toBe('watch');
    expect(recommendation.bull).toEqual([{ point: 'b', citations: ['PMID:1'] }]);
  });

  it('consults conclusions, not the claim count: plenty of claims but no conclusion abstains', async () => {
    // The wiring assertion. Under the old raw-count gate six verified claims
    // cleared it outright. Coverage asks a different question, and these
    // sections answer none of it.
    const gen = vi.fn();
    const { recommendation } = await synthesizeRecommendation({
      target: 'EGFR',
      sections: [section('target_biology', 3), section('moa_pathway', 3)],
      weighing: { takeaway: '', claims: [] }, evidence: abstentionEvidence, model: { generateStructured: gen } as any,
    });
    expect(recommendation.verdict).toBe('insufficient-evidence');
    expect(gen).not.toHaveBeenCalled();
  });

  it('abstains when a critical axis reached only insufficient_evidence', async () => {
    const gen = vi.fn();
    const { recommendation } = await synthesizeRecommendation({
      target: 'EGFR',
      sections: [section('target_biology', 2, q1Covered), section('moa_pathway', 1, q2Insufficient)],
      weighing: { takeaway: '', claims: [] }, evidence: abstentionEvidence, model: { generateStructured: gen } as any,
    });
    expect(recommendation.verdict).toBe('insufficient-evidence');
    expect(gen).not.toHaveBeenCalled();
  });

  it('names the coverage reasons in the abstaining memo', async () => {
    const gen = vi.fn();
    const { recommendation, executiveRead } = await synthesizeRecommendation({
      target: 'EGFR',
      sections: [section('target_biology', 3), section('moa_pathway', 3)],
      weighing: { takeaway: '', claims: [] }, evidence: abstentionEvidence, model: { generateStructured: gen } as any,
    });
    expect(recommendation.bottomLine).toContain('moa_pathway');
    expect(executiveRead).toContain('target_biology');
  });

  it('honours a supplied verdict over what the sections would imply', async () => {
    // The run decides; synthesis consumes. Sections that would clear the gate
    // on their own still abstain when the run says the research did not.
    const gen = vi.fn();
    const { recommendation } = await synthesizeRecommendation({
      target: 'EGFR',
      sections: [section('target_biology', 2, q1Covered), section('moa_pathway', 0, q2Covered)],
      weighing: { takeaway: '', claims: [] }, evidence: abstentionEvidence, model: { generateStructured: gen } as any,
      abstention: { proceed: false, reasons: ['critical axis moa_pathway has no conclusion'] },
    });
    expect(recommendation.verdict).toBe('insufficient-evidence');
    expect(gen).not.toHaveBeenCalled();
  });
});

describe('synthesizeRecommendation contradictions', () => {
  it('renders contradictions into the digest and instructs the bear case', async () => {
    let prompt = ''; let system = '';
    const model = synthModel(
      { verdict: 'watch', thesis: 't', framing: 'f', bull: [], bear: [], bottomLine: 'bl', conditions: [], executiveRead: 'e' },
      { onWrite: (o) => { prompt = o.prompt; system = o.system; } },
    );
    const contradictions: ContradictionFlag[] = [{ evidenceIdA: 'PMID:1', evidenceIdB: 'PMID:2', endpoint: 'OS', explanation: 'opposite OS effect' }];
    await synthesizeRecommendation({
      target: 'EGFR',
      sections: [{ kind: 'research', id: 'a', title: 'A', takeaway: 't', rag: 'green', sources: ['PMID:1'],
        claims: [
          { id: 'c1', text: 'x', citations: ['PMID:1'], confidence: 0.9 },
          { id: 'c2', text: 'y', citations: ['PMID:2'], confidence: 0.9 },
        ] }] as never,
      weighing: { takeaway: '', claims: [] },
      evidence: [
        { id: 'PMID:1', kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' },
        { id: 'PMID:2', kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' },
      ] as never,
      model: model as never,
      contradictions, abstention: PROCEED,
    });
    expect(prompt).toContain('## Contradictions');
    expect(prompt).toContain('opposite OS effect');
    expect(system.toLowerCase()).toContain('contradiction');
  });
});
