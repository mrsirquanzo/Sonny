import { describe, it, expect } from 'vitest';
import { SPECIALISTS } from './specialists.js';
import { selectSpecialists } from './planner.js';
import type { StructuredModel } from './model.js';

describe('specialist selection', () => {
  it('registry has the five scientific specialists', () => {
    expect(SPECIALISTS.map((s) => s.id)).toEqual([
      'target_biology', 'disease_indications', 'clinical_translational', 'safety_tox', 'competitive_landscape',
    ]);
  });

  it('returns model selection and derives skipped with reasons', async () => {
    const model: StructuredModel = {
      async generateStructured({ schema }) {
        return schema.parse({ selected: ['target_biology', 'disease_indications'],
          skipped: [{ id: 'competitive_landscape', reason: 'no competitive question posed' }] });
      },
    };
    const { selected, skipped } = await selectSpecialists('What diseases is CDCP1 associated with?', model);
    expect(selected).toContain('target_biology');
    expect(skipped.find((s) => s.id === 'clinical_translational')).toBeTruthy(); // derived even if model omitted it
  });

  it('falls back to all specialists if model selects none', async () => {
    const model: StructuredModel = { async generateStructured({ schema }) { return schema.parse({ selected: [], skipped: [] }); } };
    const { selected } = await selectSpecialists('CDCP1', model);
    expect(selected).toHaveLength(5);
  });
});
