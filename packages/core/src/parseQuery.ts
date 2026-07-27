import { z } from 'zod';
import type { TargetIdentity, TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';

// The result of reading a free-form research request. `target` is the bare
// molecular symbol the structured tools key off (HPA/GTEx/Open Targets query by
// gene symbol, not a sentence); indication/modality steer specialist framing.
export interface ParsedResearchQuery {
  /** Bare symbol for symbol-keyed tools. Kept a string for back-compat. */
  target: string;
  /**
   * Structured identity resolved from the same input. Additive: changing
   * `target` itself to a TargetIdentity ripples through every specialist and
   * belongs with scope propagation in slice 3, not the evidence layer.
   */
  targetIdentity: TargetIdentity;
  indication?: string;
  modality?: string;
}

const ParseSchema = z.object({
  target: z.string().min(1),
  indication: z.string().optional(),
  modality: z.string().optional(),
});

// A single bare token (e.g. "CDCP1", "HER2") is already a clean target - no
// disease or modality to extract, so skip the model call entirely.
export function looksLikeFreeText(query: string): boolean {
  return /\s/.test(query.trim());
}

// Extract the primary target symbol plus optional indication and modality from
// a natural-language request. Never throws: on any failure the caller falls
// back to treating the raw text as the target (prior behaviour).
export async function parseResearchQuery(
  model: StructuredModel,
  rawQuery: string,
): Promise<ParsedResearchQuery> {
  const parsed = await model.generateStructured({
    system:
      'You read a biomedical target-assessment request and extract its scope. Return: ' +
      'target = the primary molecular target as a bare gene or protein symbol only ' +
      '(e.g. "CDCP1", "HER2", "TROP2", "KRAS G12C") - never a sentence, never the disease, never the modality. ' +
      'indication = the disease or tumour type if one is stated (e.g. "NSCLC", "pancreatic cancer"), else omit. ' +
      'modality = the therapeutic format if one is stated (e.g. "ADC", "bispecific antibody", "small molecule"), else omit. ' +
      'If no explicit target symbol is present, set target to the most specific gene/protein named. Do not invent an indication or modality that is not stated.',
    prompt: `REQUEST:\n${rawQuery}`,
    schema: ParseSchema,
    model: MODEL_ROUTER.specialist,
  });
  const clean = (v?: string): string | undefined => {
    const t = v?.trim();
    return t && t.toLowerCase() !== 'not specified' && t.toLowerCase() !== 'none' ? t : undefined;
  };
  const identity = resolveTargetIdentity(parsed.target.trim());
  return {
    target: retrievalSymbolOf(identity, parsed.target.trim()),
    targetIdentity: identity,
    ...(clean(parsed.indication) ? { indication: clean(parsed.indication) } : {}),
    ...(clean(parsed.modality) ? { modality: clean(parsed.modality) } : {}),
  };
}

// Resolve a run's target + scope from whatever the caller supplied. When the
// query is a single symbol, use it verbatim (no model call). When it reads as
// free text, ask the model to parse it; on failure, degrade visibly and fall
// back to the raw text as target.
export async function resolveQueryScope(opts: {
  rawQuery: string;
  model: StructuredModel;
  emit: (e: TraceEvent) => void;
}): Promise<ParsedResearchQuery> {
  const { rawQuery, model, emit } = opts;
  const query = rawQuery.trim();
  if (!looksLikeFreeText(query)) {
    const identity = resolveTargetIdentity(query);
    return { target: retrievalSymbolOf(identity, query), targetIdentity: identity };
  }
  try {
    const parsed = await parseResearchQuery(model, query);
    emit({
      type: 'query_parsed',
      target: parsed.target,
      ...(parsed.indication ? { indication: parsed.indication } : {}),
      ...(parsed.modality ? { modality: parsed.modality } : {}),
    });
    return parsed;
  } catch (err) {
    emit({ type: 'error', message: `query parse failed, using raw text as target: ${String(err)}` });
    const identity = resolveTargetIdentity(query);
    return { target: retrievalSymbolOf(identity, query), targetIdentity: identity };
  }
}

/**
 * Split a variant-qualified target into a symbol plus target form.
 *
 * Structured tools (Open Targets, HPA, GTEx, ClinicalTrials) key off a bare
 * gene symbol, so passing "KRAS G12C" whole silently degraded every structured
 * lookup. Deterministic, no model call: a trailing protein-variant or
 * exon/fusion token is stripped from the symbol and retained as targetForm.
 */
const VARIANT_TOKEN = /^(?:[A-Z]\d{1,4}[A-Z*]?|del\w*|ins\w*|fs\*?\d*|ex\d+|[A-Z]\d{1,4}fs)$/;

export function resolveTargetIdentity(raw: string): TargetIdentity {
  const text = raw.trim();
  const fusion = text.match(/^([A-Za-z0-9-]+)\s*[-::]\s*([A-Za-z0-9]+)\s+fusion$/i);
  if (fusion) return { kind: 'fusion', partners: [fusion[1], fusion[2]] };
  const parts = text.split(/\s+/);
  if (parts.length === 2 && VARIANT_TOKEN.test(parts[1].toUpperCase())) {
    return { kind: 'gene_or_protein', symbol: parts[0], targetForm: parts[1] };
  }
  return { kind: 'gene_or_protein', symbol: text };
}

/** The string a symbol-keyed tool should receive for an identity. */
export function retrievalSymbolOf(identity: TargetIdentity, fallback: string): string {
  if (identity.kind === 'gene_or_protein') return identity.symbol;
  if (identity.kind === 'peptide_hla') return identity.sourceGene;
  if (identity.kind === 'fusion') return identity.partners[0];
  return fallback;
}
