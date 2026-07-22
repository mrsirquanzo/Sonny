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

/**
 * Coarse model-family label from a model id. Decorrelation is a property of the
 * FAMILY, not the backend: on ollama, qwen (writer) vs llama (verifier) is already
 * cross-family, while on anthropic, opus (writer) vs sonnet (verifier) is NOT -
 * both are Claude. Verification must run on a family different from the writer's.
 */
export function modelFamily(id: string): string {
  const s = id.toLowerCase();
  if (/(claude|opus|sonnet|haiku)/.test(s)) return 'claude';
  if (s.includes('qwen')) return 'qwen';
  if (s.includes('llama')) return 'llama';
  if (/(gpt|openai)/.test(s)) return 'gpt';
  if (/(gemini|google)/.test(s)) return 'gemini';
  if (/(mistral|mixtral)/.test(s)) return 'mistral';
  return s.split(/[:/]/)[0] || s;
}

export interface ResolvedVerifier { model: StructuredModel; modelId: string; decorrelated: boolean }

/**
 * Structural shape of a usage sink - anything with `record`. Kept structural so
 * model.ts never has to import usageMeter.ts (which imports contracts).
 */
export interface UsageRecorder {
  record(model: string, u: { tokensIn: number; tokensOut: number }): void;
}

/**
 * Resolve a verifier that is a different model family from the writer, so
 * verification is genuinely decorrelated (Sonny's rule: the judge is never the
 * writer's family). If the backend's own verifier is already cross-family
 * (ollama, groq), use it as-is. If it shares the writer's family (anthropic:
 * opus vs sonnet), cross to a different provider - local ollama/llama - so the
 * check is independent. If nothing decorrelated is reachable, return the
 * same-family verifier with `decorrelated: false` so callers can flag it
 * VISIBLY rather than degrade silently.
 */
export function resolveVerifier(
  backend: Backend = currentBackend(),
  meter?: UsageRecorder,
): ResolvedVerifier {
  const router = routerFor(backend);
  if (modelFamily(router.writer) !== modelFamily(router.verifier)) {
    return { model: makeModel(meter), modelId: router.verifier, decorrelated: true };
  }
  const crossVerifier = routerFor('ollama').verifier; // local llama, different family from Claude
  if (modelFamily(crossVerifier) !== modelFamily(router.writer)) {
    const onUsage = meter
      ? (u: { model: string; tokensIn: number; tokensOut: number }) =>
          meter.record(u.model, { tokensIn: u.tokensIn, tokensOut: u.tokensOut })
      : undefined;
    return { model: new OllamaModel({ onUsage }), modelId: crossVerifier, decorrelated: true };
  }
  return { model: makeModel(meter), modelId: router.verifier, decorrelated: false };
}

/**
 * Wrap a model so every generateStructured call is pinned to `modelId`,
 * regardless of the id the caller passes. Lets a decorrelated verifier be
 * injected as the shared `verifierModel` instance without threading its id
 * through every verify call site.
 */
export function pinVerifierModel(inner: StructuredModel, modelId: string): StructuredModel {
  return {
    generateStructured: (opts) => inner.generateStructured({ ...opts, model: modelId }),
  };
}

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
  private onUsage?: (u: { tokensIn: number; tokensOut: number; model: string }) => void;

  constructor(
    apiKey = process.env.ANTHROPIC_API_KEY,
    onUsage?: (u: { tokensIn: number; tokensOut: number; model: string }) => void,
  ) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required');
    this.client = new Anthropic({ apiKey });
    this.onUsage = onUsage;
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

    this.onUsage?.({
      model: opts.model,
      tokensIn: res.usage.input_tokens,
      tokensOut: res.usage.output_tokens,
    });

    const block = res.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') {
      throw new Error('model did not return structured output');
    }
    return opts.schema.parse(block.input);
  }
}

/**
 * `meter` is optional and structural (anything with `record`) so passing a
 * UsageMeter needs no import cycle between model.ts and usageMeter.ts. When
 * omitted, models report no usage and behave exactly as before.
 */
export function makeModel(meter?: UsageRecorder): StructuredModel {
  const onUsage = meter
    ? (u: { tokensIn: number; tokensOut: number; model: string }) => meter.record(u.model, u)
    : undefined;
  switch (currentBackend()) {
    case 'ollama': return new OllamaModel({ onUsage });
    case 'anthropic': return new AnthropicModel(undefined, onUsage);
    case 'openai': return new OpenAICompatModel(undefined, undefined, onUsage);
  }
}
