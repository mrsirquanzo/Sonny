import { z } from 'zod';
import type { TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { StructuredModel } from './model.js';
import { MODEL_ROUTER } from './model.js';

// The result of reading a free-form research request. `target` is the bare
// molecular symbol the structured tools key off (HPA/GTEx/Open Targets query by
// gene symbol, not a sentence); indication/modality steer specialist framing.
export interface ParsedResearchQuery {
  target: string;
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
  return {
    target: parsed.target.trim(),
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
  if (!looksLikeFreeText(query)) return { target: query };
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
    return { target: query };
  }
}
