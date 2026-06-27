import Anthropic from '@anthropic-ai/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodType } from 'zod';

export const MODEL_ROUTER = {
  planner: 'claude-opus-4-8',
  specialist: 'claude-opus-4-8',
  verifier: 'claude-sonnet-4-6',
  writer: 'claude-opus-4-8',
} as const;

export interface StructuredModel {
  generateStructured<T>(opts: {
    system: string;
    prompt: string;
    schema: ZodType<T>;
    model: string;
  }): Promise<T>;
}

export class AnthropicModel implements StructuredModel {
  private client: Anthropic;

  constructor(apiKey = process.env.ANTHROPIC_API_KEY) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required');
    this.client = new Anthropic({ apiKey });
  }

  async generateStructured<T>(opts: {
    system: string;
    prompt: string;
    schema: ZodType<T>;
    model: string;
  }): Promise<T> {
    const jsonSchema = zodToJsonSchema(opts.schema as ZodType<unknown>, 'Output') as Record<string, unknown>;
    const inputSchema = (
      (jsonSchema.definitions as Record<string, unknown>)?.Output ?? jsonSchema
    ) as Anthropic.Tool['input_schema'];

    const tool: Anthropic.Tool = {
      name: 'emit',
      description: 'Return the structured result.',
      input_schema: inputSchema,
    };

    const res = await this.client.messages.create({
      model: opts.model,
      max_tokens: 4096,
      system: opts.system,
      tools: [tool],
      tool_choice: { type: 'tool', name: 'emit' },
      messages: [{ role: 'user', content: opts.prompt }],
    });

    const block = res.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') {
      throw new Error('model did not return structured output');
    }
    return opts.schema.parse(block.input);
  }
}
