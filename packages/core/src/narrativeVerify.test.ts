import { describe, it, expect } from 'vitest';
import { makeDecorrelatedVerifier, verifyNarrative } from './narrativeVerify.js';
import type { StructuredModel } from './model.js';
import type { CompetitiveIP, PatentWorkup } from './patentWorkup.js';

const workup: PatentWorkup = {
  patentNumber: 'US10123456',
  patent: { input: 'US10123456', found: true, applicants: ['ACME'], inventors: [], ipc: [], family: [] },
  constructs: [{ name: 'Ab1', regions: [{ regionLabel: 'VH', seqId: 1, residues: 'EVQL' }], species: { classification: 'human-like', evidence: '' } }],
  ungrouped: [], narrative: { summary: '', points: [] }, graph: [],
};

const ip: CompetitiveIP = { summary: 'ACME owns a human-like antibody.', points: [
  { point: 'VH is disclosed as SEQ 1', citations: ['SEQ:1'] },
  { point: 'This is the market-leading antibody', citations: ['SEQ:1'] },
] };

// Inject model factories so the selector never constructs a real AnthropicModel (which throws without a key).
const stub: StructuredModel = { async generateStructured() { return {} as never; } };
const factories = { anthropic: () => stub, ollama: () => stub };

describe('makeDecorrelatedVerifier', () => {
  it('picks the opposite backend when available (ollama primary + anthropic key)', () => {
    const v = makeDecorrelatedVerifier('ollama', { anthropicKeyPresent: true, ...factories });
    expect(v.decorrelated).toBe(true);
    expect(v.modelId).toBe('claude-sonnet-4-6'); // anthropic verifier
  });
  it('falls back to same-family with decorrelated:false when the opposite is unavailable', () => {
    const v = makeDecorrelatedVerifier('ollama', { anthropicKeyPresent: false, ...factories });
    expect(v.decorrelated).toBe(false);
    expect(v.modelId).toBe('llama3.1:8b'); // ollama verifier (same family, different weight)
  });
  it('uses ollama (assumed available) as the opposite of anthropic', () => {
    const v = makeDecorrelatedVerifier('anthropic', { anthropicKeyPresent: true, ...factories });
    expect(v.decorrelated).toBe(true);
    expect(v.modelId).toBe('llama3.1:8b');
  });
});

describe('verifyNarrative', () => {
  it('attaches per-point verdicts and keeps (flags) an overreach point', async () => {
    const model: StructuredModel = {
      async generateStructured(opts: { prompt: string }) {
        return { status: opts.prompt.includes('market-leading') ? 'overreach' : 'supported', rationale: '' } as never;
      },
    };
    const out = await verifyNarrative(ip, workup, { model, modelId: 'x', decorrelated: true });
    expect(out.decorrelated).toBe(true);
    expect(out.verified).toBe(true);
    expect(out.points[0].verdict).toBe('supported');
    expect(out.points[1].verdict).toBe('overreach');   // kept and flagged, not dropped
    expect(out.points).toHaveLength(2);
  });

  it('degrades to unverified without throwing when the verifier model errors', async () => {
    const model: StructuredModel = { async generateStructured() { throw new Error('down'); } };
    const out = await verifyNarrative(ip, workup, { model, modelId: 'x', decorrelated: true });
    expect(out.verified).toBe(false);
    expect(out.points.every((p) => p.verdict === 'unverified')).toBe(true);
  });
});
