import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { OpenAICompatModel } from './openaiCompatModel.js';

const schema = z.object({ verdict: z.string(), score: z.number() });

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpenAICompatModel', () => {
  it('requires base url and api key', () => {
    expect(() => new OpenAICompatModel(undefined, 'k')).toThrow(/BASE_URL/);
    expect(() => new OpenAICompatModel('http://x/v1', undefined)).toThrow(/API_KEY/);
  });

  it('posts a forced emit tool call and parses its arguments', async () => {
    const fetchMock = mockFetchOnce({
      choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ verdict: 'GO', score: 0.9 }) } }] } }],
    });
    vi.stubGlobal('fetch', fetchMock);

    const m = new OpenAICompatModel('https://api.groq.com/openai/v1/', 'gsk_test');
    const out = await m.generateStructured({ system: 's', prompt: 'p', schema, model: 'kimi' });

    expect(out).toEqual({ verdict: 'GO', score: 0.9 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions'); // trailing slash trimmed
    const sent = JSON.parse((init as { body: string }).body);
    expect(sent.model).toBe('kimi');
    expect(sent.tool_choice).toEqual({ type: 'function', function: { name: 'emit' } });
    expect(sent.tools[0].function.name).toBe('emit');
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer gsk_test');
  });

  it('throws with detail on a non-ok response', async () => {
    vi.stubGlobal('fetch', mockFetchOnce('rate limited', false, 429));
    const m = new OpenAICompatModel('http://x/v1', 'k');
    await expect(m.generateStructured({ system: 's', prompt: 'p', schema, model: 'm' })).rejects.toThrow(/429/);
  });

  it('throws when the model returns no tool call', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({ choices: [{ message: { content: 'no tool' } }] }));
    const m = new OpenAICompatModel('http://x/v1', 'k');
    await expect(m.generateStructured({ system: 's', prompt: 'p', schema, model: 'm' })).rejects.toThrow(/structured tool call/);
  });

  it('validates the parsed output against the schema', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({
      choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ verdict: 'GO' }) } }] } }],
    }));
    const m = new OpenAICompatModel('http://x/v1', 'k');
    await expect(m.generateStructured({ system: 's', prompt: 'p', schema, model: 'm' })).rejects.toThrow();
  });
});
