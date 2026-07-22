/**
 * Published list prices in USD per million tokens.
 *
 * This table is MANUALLY MAINTAINED - provider prices change and nothing here
 * fetches them. A model missing from the table yields `undefined`, never 0, so
 * an unknown price is reported as unknown rather than as free.
 */
export const PRICE_PER_MTOK: Record<string, { in: number; out: number }> = {
  'openai/gpt-oss-120b': { in: 0.15, out: 0.75 },
  'llama-3.3-70b-versatile': { in: 0.59, out: 0.79 },
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

// Locally hosted models cost nothing per token.
const LOCAL_PREFIXES = ['ollama/', 'local/'];

export function costFor(model: string, tokensIn: number, tokensOut: number): number | undefined {
  if (LOCAL_PREFIXES.some((p) => model.startsWith(p))) return 0;
  const price = PRICE_PER_MTOK[model];
  if (!price) return undefined;
  return (tokensIn / 1_000_000) * price.in + (tokensOut / 1_000_000) * price.out;
}
