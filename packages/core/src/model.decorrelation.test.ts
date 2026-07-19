import { describe, it, expect } from 'vitest';
import { modelFamily, resolveVerifier, pinVerifierModel, routerFor, type StructuredModel } from './model.js';

describe('modelFamily', () => {
  it('groups Claude tiers into one family (opus and sonnet are NOT decorrelated)', () => {
    expect(modelFamily('claude-opus-4-8')).toBe('claude');
    expect(modelFamily('claude-sonnet-4-6')).toBe('claude');
    expect(modelFamily('claude-opus-4-8')).toBe(modelFamily('claude-sonnet-4-6'));
  });
  it('separates qwen and llama (ollama writer vs verifier IS decorrelated)', () => {
    expect(modelFamily('qwen2.5:14b')).toBe('qwen');
    expect(modelFamily('llama3.1:8b')).toBe('llama');
    expect(modelFamily('qwen2.5:14b')).not.toBe(modelFamily('llama3.1:8b'));
  });
  it('separates gpt-oss and llama (groq writer vs verifier IS decorrelated)', () => {
    expect(modelFamily('openai/gpt-oss-120b')).toBe('gpt');
    expect(modelFamily('llama-3.3-70b-versatile')).toBe('llama');
  });
});

describe('resolveVerifier', () => {
  it('ollama: keeps the cross-family default (qwen writer, llama verifier)', () => {
    const v = resolveVerifier('ollama');
    expect(v.decorrelated).toBe(true);
    expect(v.modelId).toBe(routerFor('ollama').verifier);
    expect(modelFamily(v.modelId)).not.toBe(modelFamily(routerFor('ollama').writer));
  });
  it('groq: keeps the cross-lineage default (gpt-oss writer, llama verifier)', () => {
    const v = resolveVerifier('openai');
    expect(v.decorrelated).toBe(true);
    expect(modelFamily(v.modelId)).not.toBe(modelFamily(routerFor('openai').writer));
  });
  it('anthropic: same-family default is replaced by a cross-family verifier', () => {
    const v = resolveVerifier('anthropic');
    // opus writer / sonnet verifier are both Claude, so the resolver must cross out.
    expect(modelFamily(v.modelId)).not.toBe(modelFamily(routerFor('anthropic').writer));
    expect(v.decorrelated).toBe(true);
  });
});

describe('pinVerifierModel', () => {
  it('forces the pinned model id regardless of the id the caller passes', async () => {
    const seen: string[] = [];
    const inner: StructuredModel = {
      generateStructured: async (opts) => { seen.push(opts.model); return {} as never; },
    };
    const pinned = pinVerifierModel(inner, 'llama3.1:8b');
    await pinned.generateStructured({ system: 's', prompt: 'p', schema: {} as never, model: 'claude-sonnet-4-6' });
    expect(seen).toEqual(['llama3.1:8b']);
  });
});
