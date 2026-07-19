import { describe, it, expect, vi } from 'vitest';
import type { Section, Claim, Evidence, ContradictionFlag } from '@mrsirquanzo/sonny-shared';
import type { StructuredModel } from './model.js';
import { synthesizeRecommendation } from './synthesize.js';

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

describe('synthesizeRecommendation', () => {
  it('produces a recommendation from verified claims and drops phantom citations', async () => {
    let prompt = '';
    const model: StructuredModel = {
      async generateStructured(opts) {
        prompt = opts.prompt;
        return {
          verdict: 'watch', thesis: 'Mechanistically interesting, under-validated.',
          bull: [{ point: 'Strong mechanism.', citations: ['PMID:1', 'PMID:999'] }], // PMID:999 is phantom
          bear: [{ point: 'Weak genetics.', citations: ['PMID:1'] }],
          conditions: ['A positive Phase 1 readout moves to GO.'],
          executiveRead: 'CDCP1 is mechanistically compelling but genetically thin.',
        } as never;
      },
    };
    const { recommendation, executiveRead } = await synthesizeRecommendation({ target: 'CDCP1', sections, weighing, evidence, model });
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
    const model: StructuredModel = {
      async generateStructured(opts) {
        prompt = opts.prompt; system = opts.system;
        return { verdict: 'watch', thesis: 't', bull: [], bear: [], conditions: [], executiveRead: 'er' } as never;
      },
    };
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
      model,
    });
    expect(prompt).toContain('unpowered post-hoc subgroup'); // high flag surfaced to the writer
    expect(prompt).not.toContain('open label');              // low flag not surfaced
    expect(system.toLowerCase()).toContain('audit');         // writer instructed to weave the caveat
  });

  it('forces NO-GO when any section carries a severe developability risk, even on a go draft', async () => {
    let prompt = '';
    const model: StructuredModel = {
      async generateStructured(opts) { prompt = opts.prompt;
        return { verdict: 'go', thesis: 'strong biology', bull: [], bear: [], conditions: [], executiveRead: 'er' } as never; },
    };
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
      model,
    });
    expect(recommendation.verdict).toBe('no-go');          // severe developability overrides the go draft
    expect(prompt).toContain('High ADA incidence.');       // risk surfaced to the writer
  });

  it('does not override the verdict for a significant-only developability risk', async () => {
    const model: StructuredModel = {
      async generateStructured() { return { verdict: 'go', thesis: 't', bull: [], bear: [], conditions: [], executiveRead: 'er' } as never; },
    };
    const sections = [
      { kind: 'research', id: 'modality_developability', title: 'M', takeaway: 't', rag: 'amber', sources: ['PMID:9'], claims: [
        { id: 'm1', text: 'Feasible format.', citations: ['PMID:9'], confidence: 0.8 },
        { id: 'm2', text: 'Manufacturable.', citations: ['PMID:9'], confidence: 0.8 },
      ], developabilityRisks: [{ evidenceId: 'PMID:9', category: 'half_life', severity: 'significant', explanation: 'Short half-life.' }] },
    ];
    const { recommendation } = await synthesizeRecommendation({
      target: 'FOO', sections: sections as never, weighing: { takeaway: '', claims: [] },
      evidence: [{ id: 'PMID:9', kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' }] as never,
      model,
    });
    expect(recommendation.verdict).toBe('go');             // significant informs but does not override
  });
});

function section(id: string, claimCount: number): Section {
  return {
    kind: 'research', id, title: id, takeaway: 't',
    claims: Array.from({ length: claimCount }, (_, i) => ({
      id: `${id}-c${i}`, text: 'a finding', citations: ['PMID:1'], confidence: 0.9,
    })),
    sources: [], rag: claimCount ? 'amber' : 'red',
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

  it('takes the normal path with two or more supported claims', async () => {
    const gen = vi.fn().mockResolvedValue(abstentionDraft);
    const { recommendation } = await synthesizeRecommendation({
      target: 'EGFR', sections: [section('a', 2)],
      weighing: { takeaway: '', claims: [] }, evidence: abstentionEvidence, model: { generateStructured: gen } as any,
    });
    expect(gen).toHaveBeenCalledOnce();
    expect(recommendation.verdict).toBe('watch');
    expect(recommendation.bull).toEqual([{ point: 'b', citations: ['PMID:1'] }]);
  });
});

describe('synthesizeRecommendation contradictions', () => {
  it('renders contradictions into the digest and instructs the bear case', async () => {
    let prompt = ''; let system = '';
    const model = { async generateStructured(o: { prompt: string; system: string }) { prompt = o.prompt; system = o.system;
      return { verdict: 'watch', thesis: 't', bull: [], bear: [], conditions: [], executiveRead: 'e' } as never; } };
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
      contradictions,
    });
    expect(prompt).toContain('## Contradictions');
    expect(prompt).toContain('opposite OS effect');
    expect(system.toLowerCase()).toContain('contradiction');
  });
});
