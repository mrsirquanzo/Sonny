import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodType } from 'zod';
import type { StructuredModel } from './model.js';

/**
 * OpenAI-compatible structured-output backend.
 *
 * Works against any /v1/chat/completions endpoint that supports OpenAI-style
 * function/tool calling: Groq, NVIDIA NIM, OpenRouter, Together, Fireworks,
 * Ollama's OpenAI-compat proxy. Config is env-driven so the same adapter serves
 * every provider - only the base URL, key, and model id change.
 *
 *   SONNY_OPENAI_BASE_URL  e.g. https://api.groq.com/openai/v1
 *   SONNY_OPENAI_API_KEY   the provider key
 *
 * Structured output is obtained by forcing a single `emit` tool call whose
 * parameters are the caller's JSON schema, mirroring the Anthropic backend.
 */
export class OpenAICompatModel implements StructuredModel {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl = process.env.SONNY_OPENAI_BASE_URL, apiKey = process.env.SONNY_OPENAI_API_KEY) {
    if (!baseUrl) throw new Error('SONNY_OPENAI_BASE_URL is required for the openai backend');
    if (!apiKey) throw new Error('SONNY_OPENAI_API_KEY is required for the openai backend');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  async generateStructured<T>(opts: {
    system: string;
    prompt: string;
    schema: ZodType<T>;
    model: string;
  }): Promise<T> {
    // Inline every sub-schema ($refStrategy: 'none') so the tool parameters are
    // fully self-contained. The default emits `$ref: #/definitions/...` for
    // nested/reused schemas; strict OpenAI-compatible validators (e.g. Groq)
    // reject those because the referenced definitions aren't included in the
    // extracted parameters object, failing with "... items not found".
    const parameters = zodToJsonSchema(opts.schema as ZodType<unknown>, { $refStrategy: 'none' }) as Record<string, unknown>;
    delete (parameters as { $schema?: unknown }).$schema;

    const baseMessages = [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.prompt },
    ];
    // Some open models (e.g. gpt-oss on Groq) intermittently answer with prose
    // instead of calling the forced `emit` tool; strict providers then 400 with
    // `tool_use_failed`. Retry with an escalating reminder - it is stochastic and
    // usually succeeds on a second attempt - before giving up.
    const ATTEMPTS = 4;
    let lastErr = '';
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const messages = attempt === 0
        ? baseMessages
        : [...baseMessages, { role: 'system', content: 'You MUST call the function named exactly `emit` (no other tool name) and pass arguments that match its JSON schema exactly - correct property names, no extra properties, all required fields present. Do not write prose.' }];
      const body = {
        model: opts.model,
        max_tokens: 4096,
        messages,
        tools: [{ type: 'function', function: { name: 'emit', description: 'Return the structured result.', parameters } }],
        tool_choice: { type: 'function', function: { name: 'emit' } },
      };

      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        lastErr = `openai-compat request failed (${res.status}): ${detail.slice(0, 300)}`;
        // Flaky tool-callers (e.g. gpt-oss) intermittently answer with prose,
        // emit the wrong tool name, or return arguments that miss the schema.
        // All are stochastic and usually pass on a retry with a firmer reminder.
        const retryable400 = /tool_use_failed|did not call a tool|did not match schema|tool call validation failed|not in request\.tools|output_parse_failed|parsing failed/i.test(detail);
        // Token-per-minute rate limits are transient: back off and retry.
        const rateLimited = res.status === 429;
        if ((res.status === 400 && retryable400) || rateLimited) {
          if (rateLimited) {
            const wait = Number(/try again in ([0-9.]+)s/i.exec(detail)?.[1]) || 3;
            await new Promise((r) => setTimeout(r, Math.min(wait * 1000 + 250, 15000)));
          }
          continue;
        }
        throw new Error(lastErr);
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>;
      };
      const args = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
      if (typeof args !== 'string') { lastErr = 'model did not return a structured tool call'; continue; }

      let parsed: unknown;
      try { parsed = JSON.parse(args); } catch { lastErr = 'model returned invalid JSON in the structured tool call'; continue; }
      return opts.schema.parse(parsed);
    }
    throw new Error(lastErr || 'openai-compat structured call failed after retries');
  }
}
