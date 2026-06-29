import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { OllamaModel } from './ollamaModel.js';

const Schema = z.object({ verdict: z.string(), score: z.number() });

describe('OllamaModel', () => {
  it('calls Ollama /api/chat with the schema as format and parses the structured content', async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const fakeFetch = (async (url, init) => {
      captured = { url: String(url), body: JSON.parse(String((init as RequestInit).body)) };
      return new Response(JSON.stringify({ message: { content: '{"verdict":"go","score":0.9}' } }), { status: 200 });
    }) as unknown as typeof fetch;

    const model = new OllamaModel({ baseUrl: 'http://localhost:11434', fetchImpl: fakeFetch });
    const out = await model.generateStructured({ system: 'sys', prompt: 'pr', schema: Schema, model: 'qwen2.5:14b' });

    expect(out).toEqual({ verdict: 'go', score: 0.9 });
    expect(captured!.url).toBe('http://localhost:11434/api/chat');
    expect(captured!.body.model).toBe('qwen2.5:14b');
    expect(captured!.body.stream).toBe(false);
    expect(captured!.body.format).toBeTypeOf('object'); // a JSON schema object, not a string
    const messages = captured!.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(messages[1]).toEqual({ role: 'user', content: 'pr' });
  });

  it('throws on a non-ok response', async () => {
    const fakeFetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const model = new OllamaModel({ fetchImpl: fakeFetch });
    await expect(model.generateStructured({ system: 's', prompt: 'p', schema: Schema, model: 'qwen2.5:14b' }))
      .rejects.toThrow(/Ollama HTTP 500/);
  });

  it('throws when the content is not valid JSON for the schema', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ message: { content: '{"verdict":"go"}' } }), { status: 200 })) as unknown as typeof fetch;
    const model = new OllamaModel({ fetchImpl: fakeFetch });
    await expect(model.generateStructured({ system: 's', prompt: 'p', schema: Schema, model: 'qwen2.5:14b' }))
      .rejects.toThrow(); // missing required "score"
  });
});
