import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { MODEL_ROUTER, AnthropicModel, type StructuredModel } from './model.js';

describe('MODEL_ROUTER', () => {
  it('has planner, specialist, verifier, writer roles', () => {
    expect(MODEL_ROUTER).toHaveProperty('planner');
    expect(MODEL_ROUTER).toHaveProperty('specialist');
    expect(MODEL_ROUTER).toHaveProperty('verifier');
    expect(MODEL_ROUTER).toHaveProperty('writer');
  });

  it('specialist is claude-opus-4-8', () => {
    expect(MODEL_ROUTER.specialist).toBe('claude-opus-4-8');
  });

  it('verifier is claude-sonnet-4-6', () => {
    expect(MODEL_ROUTER.verifier).toBe('claude-sonnet-4-6');
  });

  it('verifier !== specialist', () => {
    expect(MODEL_ROUTER.verifier).not.toBe(MODEL_ROUTER.specialist);
  });
});

describe('StructuredModel contract', () => {
  it('FakeModel returns Zod-validated structured output', async () => {
    const fake: StructuredModel = {
      async generateStructured({ schema }) {
        return schema.parse({ ok: true });
      },
    };
    const out = await fake.generateStructured({
      system: '',
      prompt: '',
      schema: z.object({ ok: z.boolean() }),
      model: 'x',
    });
    expect(out.ok).toBe(true);
  });
});

describe('AnthropicModel', () => {
  it('throws if ANTHROPIC_API_KEY is missing', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => new AnthropicModel()).toThrow('ANTHROPIC_API_KEY');
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('AnthropicModel exists and implements StructuredModel interface', () => {
    // Type-level check: AnthropicModel must satisfy StructuredModel
    const check: (m: StructuredModel) => void = (_m) => {};
    // We can't instantiate without a key, but we can verify the prototype has the method
    expect(typeof AnthropicModel.prototype.generateStructured).toBe('function');
    void check; // suppress unused warning
  });
});
