import { describe, it, expect } from 'vitest';
import { groupConstructs } from './patentWorkup.js';
import type { StructuredModel } from './model.js';
import type { RegionAssociation } from './patentData.js';

function model(constructs: unknown): StructuredModel {
  return { async generateStructured() { return { constructs } as never; } };
}

const associations: RegionAssociation[] = [
  { regionLabel: 'VH', seqId: 1 },
  { regionLabel: 'VL', seqId: 2 },
  { regionLabel: 'CDR-H1', seqId: 3 },
];

describe('groupConstructs', () => {
  it('groups members and drops members with unknown SEQ-IDs (grounding)', async () => {
    const out = await groupConstructs('Claims\n...', associations, model([
      { name: 'Ab1', members: [{ regionLabel: 'VH', seqId: 1 }, { regionLabel: 'VL', seqId: 2 }, { regionLabel: 'CDR-H1', seqId: 99 }] },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Ab1');
    expect(out[0].members.map((m) => m.seqId)).toEqual([1, 2]); // seqId 99 not in associations -> dropped
  });

  it('drops a construct left with no known members', async () => {
    const out = await groupConstructs('c', associations, model([{ name: 'Ghost', members: [{ regionLabel: 'VH', seqId: 42 }] }]));
    expect(out).toEqual([]);
  });

  it('returns [] when the model throws', async () => {
    const throwing: StructuredModel = { async generateStructured() { throw new Error('boom'); } };
    expect(await groupConstructs('c', associations, throwing)).toEqual([]);
  });
});
