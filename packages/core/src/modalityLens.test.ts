import { describe, expect, it } from 'vitest';
import {
  CanonicalModalitySchema,
  type CanonicalModality,
} from '@mrsirquanzo/sonny-shared';
import * as lensModule from './modalityLens.js';
import type { StructuredModel } from './model.js';
import { composeRoster } from './planner.js';

type ResolvedLens = {
  modalityLensKey: CanonicalModality;
  modalityLensVersion: string;
  resolvedQ2Lens: string[];
  resolvedQ6Lens: string[];
};

/**
 * SLICE3/SPEC does not prescribe the resolver export name. Keep the assertions
 * about the normative result rather than coupling the suite to one spelling.
 */
function resolveLens(input: {
  modality: CanonicalModality;
  subtype?: string;
  action?: string;
}): ResolvedLens {
  const module = lensModule as Record<string, unknown>;
  const resolver = module.resolveModalityLens ?? module.resolveLens;
  if (typeof resolver !== 'function') {
    throw new Error('modalityLens.ts must export resolveModalityLens() or resolveLens()');
  }
  const raw = (resolver as (value: typeof input) => Record<string, unknown>)(input);
  return {
    modalityLensKey: (raw.modalityLensKey ?? raw.key) as CanonicalModality,
    modalityLensVersion: (raw.modalityLensVersion ?? raw.version) as string,
    resolvedQ2Lens: (raw.resolvedQ2Lens ?? raw.q2) as string[],
    resolvedQ6Lens: (raw.resolvedQ6Lens ?? raw.q6) as string[],
  };
}

function promptFor(roster: Awaited<ReturnType<typeof composeRoster>>, id: string): string {
  const brief = roster.find((candidate) => candidate.id === id);
  expect(brief, `missing ${id}`).toBeDefined();
  return `${brief!.title}\n${brief!.objective}\n${brief!.promptHint}`.toLowerCase();
}

const forbiddenModel = {
  async generateStructured() { throw new Error('roster composition called a model'); },
} as StructuredModel;

const smallMoleculeStrategy = {
  interventions: [{
    modality: 'small_molecule',
    engagements: [{
      target: { kind: 'gene_or_protein', symbol: 'KRAS' },
      targetRole: 'disease_driver',
      primaryAction: 'inhibit',
      biologicalIntents: ['suppress_function'],
    }],
  }],
  indication: 'NSCLC',
  strategySource: 'user_specified',
  strategyConfidence: 'high',
};

describe('slice 3 modality lens resolution', () => {
  it('has a non-empty resolution for every canonical modality key', () => {
    for (const modality of CanonicalModalitySchema.options) {
      const lens = resolveLens({ modality });
      expect(lens.modalityLensKey).toBe(modality);
      expect(lens.modalityLensVersion).toEqual(expect.any(String));
      expect(lens.modalityLensVersion.length).toBeGreaterThan(0);
      expect(lens.resolvedQ2Lens.length).toBeGreaterThan(0);
      expect(lens.resolvedQ6Lens.length).toBeGreaterThan(0);
    }
  });

  it('routes unknown to the generic fallback, never the ADC/antibody lens', () => {
    const unknown = resolveLens({ modality: 'unknown' });
    const adc = resolveLens({ modality: 'adc' });

    expect(unknown.resolvedQ2Lens).toContain('target access');
    expect(unknown.resolvedQ2Lens).toContain('target engagement');
    expect(unknown.resolvedQ6Lens).toContain('delivery and biodistribution');
    expect(unknown.resolvedQ2Lens).not.toEqual(adc.resolvedQ2Lens);
    expect(unknown.resolvedQ2Lens.join(' ')).not.toMatch(/tumour-cell surface|internalization|payload sensitivity/i);
  });

  it('layers common plus modality content and lets an overlay narrow without replacing its base', () => {
    const base = resolveLens({ modality: 'monoclonal_antibody' });
    const antagonist = resolveLens({ modality: 'monoclonal_antibody', subtype: 'antagonist' });

    // Common layer survives modality resolution.
    expect(base.resolvedQ2Lens).toContain('target engagement');
    expect(base.resolvedQ6Lens).toContain('on-target safety');
    // Modality layer is present as well.
    expect(base.resolvedQ2Lens).toContain('epitope suitability');
    expect(base.resolvedQ6Lens).toContain('immunogenicity and anti-drug antibodies');
    // A subtype overlay is additive/narrowing: it cannot erase the base.
    expect(antagonist.resolvedQ2Lens).toEqual(expect.arrayContaining(base.resolvedQ2Lens));
    expect(antagonist.resolvedQ6Lens).toEqual(expect.arrayContaining(base.resolvedQ6Lens));
    expect(new Set(antagonist.resolvedQ2Lens).size).toBe(antagonist.resolvedQ2Lens.length);
    expect(new Set(antagonist.resolvedQ6Lens).size).toBe(antagonist.resolvedQ6Lens.length);
  });

  it('injects full lens content only into Q2 and Q6 briefs', async () => {
    const roster = await composeRoster({
      target: 'KRAS',
      context: {
        indication: 'NSCLC',
        modality: 'small_molecule',
        strategy: smallMoleculeStrategy,
      } as never,
      model: forbiddenModel,
      emit: () => {},
    });
    const lens = resolveLens({ modality: 'small_molecule' });
    const lensItems = [...lens.resolvedQ2Lens, ...lens.resolvedQ6Lens].map((x) => x.toLowerCase());

    for (const id of ['target_biology', 'disease_indications', 'clinical_landscape', 'competitive_ip']) {
      const prompt = promptFor(roster, id);
      for (const item of lensItems) expect(prompt).not.toContain(item);
    }
    for (const item of lens.resolvedQ2Lens) expect(promptFor(roster, 'moa_pathway')).toContain(item.toLowerCase());
    for (const item of lens.resolvedQ6Lens) expect(promptFor(roster, 'modality_developability')).toContain(item.toLowerCase());
  });
});
