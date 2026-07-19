import { z } from 'zod';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';

const DEFAULT_VARIANT_COUNT = 4;
const cache = new Map<string, Promise<ResearchQueryVariant[]>>();

const RewritesSchema = z.object({
  variants: z.array(z.object({
    target: z.string().min(1),
    concept: z.string(),
  })).min(1).max(12),
});

export interface ResearchQueryVariant { target: string; concept: string }

export interface RewriteQueryOptions {
  target: string;
  question: string;
  concept: string;
  model: StructuredModel;
  targetAliases?: string[];
  variantCount?: number;
}

function boundedVariantCount(value = Number(process.env.SONNY_QUERY_VARIANTS ?? DEFAULT_VARIANT_COUNT)): number {
  return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 1), 8) : DEFAULT_VARIANT_COUNT;
}

function normalizeConcept(value: string, target: string): string {
  const targetPattern = new RegExp(`\\b${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'ig');
  return value
    .replace(targetPattern, ' ')
    .replace(/\b(?:AND|OR|NOT)\b/gi, ' ')
    .replace(/["'()[\]{}:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTarget(value: string, fallback: string): string {
  const cleaned = value
    .replace(/\b(?:AND|OR|NOT)\b/gi, ' ')
    .replace(/["'()[\]{}:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

/**
 * Produce bounded Europe-PMC concept facets. The original concept is always
 * first, so rewriting can only add recall and never removes the baseline query.
 */
export async function rewriteResearchQuery(opts: RewriteQueryOptions): Promise<ResearchQueryVariant[]> {
  const count = boundedVariantCount(opts.variantCount);
  const original = normalizeConcept(opts.concept, opts.target);
  const aliases = (opts.targetAliases ?? [])
    .map((alias) => normalizeTarget(alias, opts.target))
    .filter((alias) => alias.toLowerCase() !== opts.target.toLowerCase());
  if (count === 1) return [{ target: opts.target, concept: original }];

  const key = JSON.stringify([opts.target.toLowerCase(), aliases.map((a) => a.toLowerCase()).sort(), opts.question.trim().toLowerCase(), original.toLowerCase(), count]);
  let pending = cache.get(key);
  if (!pending) {
    pending = opts.model.generateStructured({
      system: `Rewrite a biomedical literature search into complementary variants. Return exactly ${count - 1} variants, each with a target and concept. Cover: (1) a recognized target synonym or alias where relevant (for example TROP2/TACSTD2), (2) a MeSH-style scientific rephrasing, and (3) a narrower mechanism or sub-question. The target is a gene/protein name or alias. The concept is a short 0-4 word facet. Do not emit full query syntax, Boolean operators, field syntax, or quotation marks. Prefer terminology likely to occur in paper titles or abstracts.`,
      prompt: `TARGET: ${opts.target}\nKNOWN TARGET ALIASES: ${aliases.join(', ') || '(none provided)'}\nQUESTION: ${opts.question}\nORIGINAL FACET: ${original || '(broad target search)'}\nReturn complementary target/facet variants.`,
      schema: RewritesSchema,
      model: MODEL_ROUTER.specialist,
    }).then(({ variants }) => {
      const out: ResearchQueryVariant[] = [{ target: opts.target, concept: original }];
      // Reserve room for semantic/decomposition variants even when the target
      // has many aliases; one alias query captures the highest-value expansion.
      for (const alias of aliases.slice(0, 1)) out.push({ target: alias, concept: original });
      for (const value of variants) {
        const normalized = {
          target: normalizeTarget(value.target, opts.target),
          concept: normalizeConcept(value.concept, opts.target),
        };
        if (!out.some((v) => v.target.toLowerCase() === normalized.target.toLowerCase()
          && v.concept.toLowerCase() === normalized.concept.toLowerCase())) out.push(normalized);
        if (out.length === count) break;
      }
      return out.slice(0, count);
    }).catch((error) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
  }
  return pending;
}

export function clearQueryRewriteCache(): void {
  cache.clear();
}
