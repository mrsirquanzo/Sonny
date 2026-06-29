import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodType } from 'zod';
import type { StructuredModel } from './model.js';

export class OllamaModel implements StructuredModel {
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.baseUrl = opts.baseUrl ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async generateStructured<T>(opts: {
    system: string; prompt: string; schema: ZodType<T>; model: string;
  }): Promise<T> {
    // Fully inline the schema ($refStrategy 'none') so Ollama's structured-output
    // engine needs no $ref resolution.
    const format = zodToJsonSchema(opts.schema as ZodType<unknown>, { $refStrategy: 'none' }) as Record<string, unknown>;

    const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.prompt },
        ],
        format,
        stream: false,
        options: { temperature: 0 },
      }),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);

    const data = (await res.json()) as { message?: { content?: string } };
    const content = data.message?.content;
    if (!content) throw new Error('Ollama returned no message content');
    return opts.schema.parse(JSON.parse(content));
  }
}
