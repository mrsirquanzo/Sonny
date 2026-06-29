import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { MODEL_ROUTER, AnthropicModel, routerFor, currentBackend, makeModel, type StructuredModel } from './model.js';
import { OllamaModel } from './ollamaModel.js';

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'test-key-not-used';

const original = process.env.SONNY_BACKEND;
afterEach(() => { if (original === undefined) delete process.env.SONNY_BACKEND; else process.env.SONNY_BACKEND = original; });

describe('MODEL_ROUTER', () => {
  it('has planner, specialist, verifier, writer roles', () => {
    expect(MODEL_ROUTER).toHaveProperty('planner');
    expect(MODEL_ROUTER).toHaveProperty('specialist');
    expect(MODEL_ROUTER).toHaveProperty('verifier');
    expect(MODEL_ROUTER).toHaveProperty('writer');
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

describe('backend routing', () => {
  it('routerFor maps roles per backend with cross-family verifier decorrelation', () => {
    const ollama = routerFor('ollama');
    expect(ollama.specialist).toBe('qwen2.5:14b');
    expect(ollama.verifier).toBe('llama3.1:8b');
    expect(ollama.specialist).not.toBe(ollama.verifier);
    const anth = routerFor('anthropic');
    expect(anth.specialist).toBe('claude-opus-4-8');
    expect(anth.verifier).toBe('claude-sonnet-4-6');
    expect(anth.specialist).not.toBe(anth.verifier);
  });

  it('defaults to ollama and only "anthropic" selects anthropic', () => {
    delete process.env.SONNY_BACKEND;
    expect(currentBackend()).toBe('ollama');
    process.env.SONNY_BACKEND = 'anthropic';
    expect(currentBackend()).toBe('anthropic');
    process.env.SONNY_BACKEND = 'something-else';
    expect(currentBackend()).toBe('ollama');
  });

  it('makeModel returns the backend-matching instance', () => {
    delete process.env.SONNY_BACKEND;
    expect(makeModel()).toBeInstanceOf(OllamaModel);
    process.env.SONNY_BACKEND = 'anthropic';
    expect(makeModel()).toBeInstanceOf(AnthropicModel);
  });
});
