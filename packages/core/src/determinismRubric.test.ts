import { describe, expect, it, vi } from 'vitest';
import type { CanonicalModality, SpecialistAxisId, TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { StructuredModel } from './model.js';
import { composeRoster } from './planner.js';

const AXES: SpecialistAxisId[] = [
  'target_biology',
  'moa_pathway',
  'disease_indications',
  'clinical_landscape',
  'competitive_ip',
  'modality_developability',
];

function forbiddenModel() {
  const generateStructured = vi.fn(async () => {
    throw new Error('composeRoster must not ask a model to author the rubric');
  });
  return {
    model: { generateStructured } as unknown as StructuredModel,
    generateStructured,
  };
}

async function compose(modality: CanonicalModality, emit: (event: TraceEvent) => void = () => {}) {
  const { model, generateStructured } = forbiddenModel();
  const strategy = {
    interventions: [{
      modality,
      engagements: [{
        target: { kind: 'gene_or_protein', symbol: modality === 'small_molecule' ? 'KRAS' : 'CDCP1' },
        targetRole: 'disease_driver',
        primaryAction: 'inhibit',
        biologicalIntents: ['suppress_function'],
      }],
    }],
    indication: 'NSCLC',
    strategySource: 'user_specified',
    strategyConfidence: 'high',
  };
  const roster = await composeRoster({
    target: modality === 'small_molecule' ? 'KRAS' : 'CDCP1',
    context: { indication: 'NSCLC', modality, strategy } as never,
    model,
    emit,
  });
  return { roster, generateStructured };
}

describe('slice 3 deterministic specialist spine', () => {
  it.each([
    'adc', 'small_molecule', 'protac', 'molecular_glue', 'sirna', 'aso',
    'monoclonal_antibody', 'bispecific_antibody', 'car_t', 'tcr_t',
    'gene_editing', 'gene_replacement', 'mrna', 'radioligand',
    'therapeutic_vaccine', 'unknown',
  ] satisfies CanonicalModality[])('never calls a model while composing a %s roster', async (modality) => {
    const { roster, generateStructured } = await compose(modality);

    expect(generateStructured, 'the rubric must be entirely code-authored').not.toHaveBeenCalled();
    expect(roster.map(({ id }) => id)).toEqual(AXES);
  });

  it('is byte-identical for identical input and emits the same deterministic audit record', async () => {
    const firstEvents: TraceEvent[] = [];
    const secondEvents: TraceEvent[] = [];
    const first = await compose('small_molecule', (event) => firstEvents.push(event));
    const second = await compose('small_molecule', (event) => secondEvents.push(event));

    expect(JSON.stringify(first.roster)).toBe(JSON.stringify(second.roster));
    expect(JSON.stringify(firstEvents.filter((e) => e.type === 'plan_composed')))
      .toBe(JSON.stringify(secondEvents.filter((e) => e.type === 'plan_composed')));
    expect(first.generateStructured).not.toHaveBeenCalled();
    expect(second.generateStructured).not.toHaveBeenCalled();
  });

  it('always instantiates exactly the six canonical axes, with stable code-authored copy', async () => {
    const adc = await compose('adc');
    const smallMolecule = await compose('small_molecule');
    const unknown = await compose('unknown');

    for (const roster of [adc.roster, smallMolecule.roster, unknown.roster]) {
      expect(roster).toHaveLength(6);
      expect(new Set(roster.map(({ id }) => id))).toEqual(new Set(AXES));
      expect(roster.every(({ title, objective, promptHint }) =>
        title.trim().length > 0 && objective.trim().length > 0 && promptHint.trim().length > 0,
      )).toBe(true);
    }

    // Modality changes may alter only deterministic lens-bearing Q2/Q6 COPY.
    //
    // Compares copy fields, not whole briefs: scope/context legitimately differ
    // across modalities because an ADC strategy carries intent
    // `exploit_as_delivery_address` and a small-molecule one `suppress_function`,
    // so their Q1 HYPOTHESIS keys differ by design. That is the Q1-per-intent
    // rule, not rubric drift.
    for (const id of ['target_biology', 'disease_indications', 'clinical_landscape', 'competitive_ip'] as const) {
      const copy = (roster: typeof adc.roster) => {
        const b = roster.find((brief) => brief.id === id)!;
        return { id: b.id, title: b.title, objective: b.objective, promptHint: b.promptHint };
      };
      expect(copy(adc.roster)).toEqual(copy(smallMolecule.roster));
    }
  });
});
