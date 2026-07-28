import { describe, expect, it } from 'vitest';
import type { CanonicalModality, TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { StructuredModel } from './model.js';
import { composeRoster } from './planner.js';

const forbiddenModel = {
  async generateStructured() { throw new Error('composeRoster must not invoke a model'); },
} as StructuredModel;

async function composed(modality: CanonicalModality) {
  const events: TraceEvent[] = [];
  const strategy = {
    interventions: [{
      modality,
      engagements: [{
        target: { kind: 'gene_or_protein', symbol: modality === 'adc' ? 'CDCP1' : 'KRAS' },
        targetRole: modality === 'adc' ? 'delivery_address' : 'disease_driver',
        primaryAction: modality === 'adc' ? 'deliver_payload' : 'inhibit',
        biologicalIntents: [
          modality === 'adc' ? 'exploit_as_delivery_address' : 'suppress_function',
        ],
      }],
    }],
    indication: 'NSCLC',
    strategySource: 'user_specified',
    strategyConfidence: 'high',
  };
  const roster = await composeRoster({
    target: modality === 'adc' ? 'CDCP1' : 'KRAS',
    context: { indication: 'NSCLC', modality, strategy } as never,
    model: forbiddenModel,
    emit: (event) => events.push(event),
  });
  const plan = events.find((event) => event.type === 'plan_composed') as
    | (TraceEvent & { resolvedStrategyLenses?: unknown[] })
    | undefined;
  return { roster, plan };
}

function text(brief: { title: string; objective: string; promptHint: string } | undefined): string {
  expect(brief).toBeDefined();
  return `${brief!.title}\n${brief!.objective}\n${brief!.promptHint}`.toLowerCase();
}

describe('slice 3 lens provenance and behavioral regressions', () => {
  it.each(['small_molecule', 'adc', 'unknown'] satisfies CanonicalModality[])(
    'records complete per-strategy lens provenance for a single %s strategy',
    async (modality) => {
      const { plan } = await composed(modality);
      expect(plan).toBeDefined();
      expect(plan).toHaveProperty('resolvedStrategyLenses');
      expect(plan!.resolvedStrategyLenses).toHaveLength(1);
      expect(plan!.resolvedStrategyLenses![0]).toMatchObject({
        strategyFingerprint: expect.any(String),
        modalityLensKey: modality,
        modalityLensVersion: expect.any(String),
        resolvedQ2Lens: expect.any(Array),
        resolvedQ6Lens: expect.any(Array),
      });
      expect(plan!.resolvedStrategyLenses![0]).not.toHaveProperty('strategyVariantLabel');
      expect((plan!.resolvedStrategyLenses![0] as { resolvedQ2Lens: unknown[] }).resolvedQ2Lens.length).toBeGreaterThan(0);
      expect((plan!.resolvedStrategyLenses![0] as { resolvedQ6Lens: unknown[] }).resolvedQ6Lens.length).toBeGreaterThan(0);
    },
  );

  it('keeps KRAS small-molecule prompts on druggability and ADME, not ADC biology', async () => {
    const { roster } = await composed('small_molecule');
    const q2 = text(roster.find((brief) => brief.id === 'moa_pathway'));
    const q6 = text(roster.find((brief) => brief.id === 'modality_developability'));
    const combined = `${q2}\n${q6}`;

    expect(q2).toContain('druggable binding pocket');
    expect(q2).toContain('intracellular target engagement');
    expect(q6).toContain('oral bioavailability');
    expect(q6).toContain('metabolic instability');
    expect(combined).not.toMatch(/surface epitope|epitope suitability|internalization|internalisation|lysosomal trafficking/);
  });

  it('keeps CDCP1 ADC prompts on the ADC lens', async () => {
    const { roster } = await composed('adc');
    const q2 = text(roster.find((brief) => brief.id === 'moa_pathway'));
    const q6 = text(roster.find((brief) => brief.id === 'modality_developability'));

    expect(q2).toContain('tumour-cell surface accessibility');
    expect(q2).toMatch(/internalization rate|internalisation rate/);
    expect(q2).toContain('payload sensitivity');
    expect(q6).toContain('on-target, off-tumour toxicity');
    expect(q6).toContain('linker instability');
  });
});
