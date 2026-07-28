import { describe, it, expect, vi } from 'vitest';
import { recoverTargetIdentity, resolveTargetIdentity } from './parseQuery.js';
import { seedSymbolsFor, seedStructuredEvidence } from './leadSeed.js';
import { EvidenceStore } from './evidenceStore.js';
import { claimId } from './researcher.js';

/** Regressions for three defects found in review of the slice 2 branch. */

describe('variant survives the free-text parse path', () => {
  it('recovers a variant the model dropped from a free-form prompt', () => {
    // The parse prompt asks for a bare symbol, so the model returns "KRAS".
    const id = recoverTargetIdentity('KRAS', 'is KRAS G12C a good small-molecule target in NSCLC?');
    expect(id).toEqual({ kind: 'gene_or_protein', symbol: 'KRAS', targetForm: 'G12C' });
  });

  it('does not invent a variant that is not in the raw query', () => {
    expect(recoverTargetIdentity('KRAS', 'is KRAS a good target?'))
      .toEqual({ kind: 'gene_or_protein', symbol: 'KRAS' });
  });

  it('leaves an already-qualified model target alone', () => {
    expect(recoverTargetIdentity('KRAS G12C', 'anything'))
      .toEqual({ kind: 'gene_or_protein', symbol: 'KRAS', targetForm: 'G12C' });
  });
});

describe('fusion targets seed both partners', () => {
  it('returns both partner symbols', () => {
    expect(resolveTargetIdentity('BCR-ABL1 fusion').kind).toBe('fusion');
    expect(seedSymbolsFor('BCR-ABL1 fusion')).toEqual(['BCR', 'ABL1']);
  });

  it('queries a symbol-keyed tool once per partner', async () => {
    const seen: unknown[] = [];
    const tool = { name: 'open_targets_target', description: '', call: vi.fn(async (args: Record<string, unknown>) => { seen.push(args); return []; }) };
    await seedStructuredEvidence({ target: 'BCR-ABL1 fusion', tools: [tool as never], store: new EvidenceStore(), emit: () => {} });
    expect(seen).toEqual([{ symbol: 'BCR' }, { symbol: 'ABL1' }]);
  });

  it('still sends a single symbol for a plain gene', async () => {
    const seen: unknown[] = [];
    const tool = { name: 'open_targets_target', description: '', call: vi.fn(async (args: Record<string, unknown>) => { seen.push(args); return []; }) };
    await seedStructuredEvidence({ target: 'KRAS G12C', tools: [tool as never], store: new EvidenceStore(), emit: () => {} });
    expect(seen).toEqual([{ symbol: 'KRAS' }]);
  });
});

describe('gap-fill claim ids do not collide across gaps', () => {
  it('distinguishes two gaps for the same specialist', () => {
    const a = claimId({ sectionKey: 'target_biology#gap:0', round: 0 }, 1);
    const b = claimId({ sectionKey: 'target_biology#gap:1', round: 0 }, 1);
    expect(a).not.toBe(b);
  });
});
