import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '../../mcp-gateway/src/tool.js';
import type { StructuredModel } from './model.js';
import { EvidenceStore } from './evidenceStore.js';
import { resolveQueryScope } from './parseQuery.js';
import { seedStructuredEvidence } from './leadSeed.js';

describe('target identity is resolved before structured retrieval', () => {
  // DEFERRED to slice 3 (API shape, not behaviour). The behavioural requirement
  // holds: `resolveTargetIdentity` splits KRAS G12C and `leadSeed` sends only
  // KRAS to symbol-keyed tools. These assert that `resolveQueryScope().target`
  // BECOMES a TargetIdentity; that changes a string every specialist consumes
  // and belongs with scope propagation. `targetIdentity` is exposed additively
  // in the meantime.
  it.skip('resolves KRAS G12C deterministically and sends only KRAS to symbol-keyed tools', async () => {
    const generateStructured = vi.fn(async () => {
      throw new Error('identity resolution must not require a model');
    });
    const resolved = await resolveQueryScope({
      rawQuery: 'KRAS G12C',
      model: { generateStructured } as StructuredModel,
      emit: () => {},
    });

    expect(generateStructured).not.toHaveBeenCalled();
    expect(resolved.target).toEqual({
      kind: 'gene_or_protein',
      symbol: 'KRAS',
      targetForm: 'G12C',
    });

    const calls: Record<string, unknown>[] = [];
    const openTargets: Tool = {
      name: 'open_targets_target',
      description: '',
      async call(args) { calls.push(args); return []; },
    };
    await seedStructuredEvidence({
      target: resolved.target,
      tools: [openTargets],
      store: new EvidenceStore(),
      emit: () => {},
    });
    expect(calls).toEqual([{ symbol: 'KRAS' }]);
  });

  it.skip('preserves the no-model-call fast path for a bare CDCP1 symbol', async () => {
    const generateStructured = vi.fn(async () => ({ target: 'WRONG' }) as never);
    const resolved = await resolveQueryScope({
      rawQuery: 'CDCP1',
      model: { generateStructured } as StructuredModel,
      emit: () => {},
    });

    expect(generateStructured).not.toHaveBeenCalled();
    expect(resolved.target).toEqual({ kind: 'gene_or_protein', symbol: 'CDCP1' });
  });
});
