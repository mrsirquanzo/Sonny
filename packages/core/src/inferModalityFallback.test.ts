import { describe, expect, it } from 'vitest';
import type { StructuredModel } from './model.js';
import {
  inferModality,
  isAntibodyModality,
} from './planner.js';

describe('inferModality failure invariant', () => {
  it.each([
    {
      name: 'model throws',
      model: { async generateStructured() { throw new Error('model unavailable'); } } as StructuredModel,
    },
    {
      name: 'model returns schema-invalid output',
      model: { async generateStructured() { return { rationale: 42 } as never; } } as StructuredModel,
    },
  ])('never throws and returns unknown when the $name', async ({ model }) => {
    const result = await inferModality('KRAS', model);
    expect(result.modality).toBe('unknown');
    expect(result.modality).not.toBe('antibody');

    // `unknown` must not enter the antibody-special-case branch. It therefore
    // remains eligible for canonicalization's generic fallback path.
    expect(isAntibodyModality(result.modality)).toBe(false);
  });
});
