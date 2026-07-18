import Anthropic from '@anthropic-ai/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodType } from 'zod';
import { OllamaModel } from './ollamaModel.js';
import { OpenAICompatModel } from './openaiCompatModel.js';
export { OllamaModel, OpenAICompatModel };

export type Backend = 'ollama' | 'anthropic' | 'openai';

export interface RoleRouter { planner: string; specialist: string; verifier: string; writer: string }

// Per-role model ids. Every backend honours the same SONNY_MODEL_* overrides so
// a role can be pointed at any hosted model (incl. free cloud models via the
// openai-compat backend) without code changes. Defaults differ per backend.
function routerWithOverrides(defaults: RoleRouter): RoleRouter {
  return {
    planner: process.env.SONNY_MODEL_PLANNER ?? defaults.planner,
    specialist: process.env.SONNY_MODEL_SPECIALIST ?? defaults.specialist,
    verifier: process.env.SONNY_MODEL_VERIFIER ?? defaults.verifier,
    writer: process.env.SONNY_MODEL_WRITER ?? defaults.writer,
  };
}

const ROUTERS: Record<Backend, RoleRouter> = {
  anthropic: routerWithOverrides({
    planner: 'claude-opus-4-8', specialist: 'claude-opus-4-8', verifier: 'claude-sonnet-4-6', writer: 'claude-opus-4-8',
  }),
  ollama: routerWithOverrides({
    planner: 'qwen2.5:14b', specialist: 'qwen2.5:14b', verifier: 'llama3.1:8b', writer: 'qwen2.5:14b',
  }),
  // Decorrelated default for free cloud open models (Groq): synthesize on
  // gpt-oss-120b (OpenAI lineage, strongest reasoning on the free tier), verify
  // on llama-3.3-70b (Meta lineage) so verification crosses model families.
  // Both tool-call reliably on Groq; qwen3.6 was dropped (unreliable tool calls).
  // Override per role via env (e.g. Kimi K2 where the account has access).
  openai: routerWithOverrides({
    planner: 'openai/gpt-oss-120b',
    specialist: 'openai/gpt-oss-120b',
    verifier: 'llama-3.3-70b-versatile',
    writer: 'openai/gpt-oss-120b',
  }),
};

export function routerFor(b: Backend): RoleRouter { return ROUTERS[b]; }

export function currentBackend(): Backend {
  const b = process.env.SONNY_BACKEND;
  if (b === 'anthropic' || b === 'openai') return b;
  return 'ollama';
}

// Evaluated at module load - reflects the backend the process was launched with.
export const MODEL_ROUTER: RoleRouter = routerFor(currentBackend());

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

export function makeModel(): StructuredModel {
  switch (currentBackend()) {
    case 'ollama': return new OllamaModel();
    case 'anthropic': return new AnthropicModel();
    case 'openai': return new OpenAICompatModel();
  }
}
