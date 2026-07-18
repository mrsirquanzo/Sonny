import { z } from 'zod';

export const ResultsSchemaVersionSchema = z.literal('1.0.0');

export const ResultComparatorSchema = z.enum(['lt', 'lte', 'eq', 'gte', 'gt', 'none']);
export const ResultDirectionSchema = z.enum(['lower', 'higher', 'neutral', 'not_applicable']);

export const ResultMissingnessSchema = z.object({
  missingN: z.number().int().nonnegative(),
  observedN: z.number().int().nonnegative(),
  totalN: z.number().int().nonnegative(),
  fraction: z.number().min(0).max(1),
}).strict().superRefine((value, ctx) => {
  if (value.missingN + value.observedN !== value.totalN) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'missingN + observedN must equal totalN' });
  }
});

const ResultFieldsSchema = z.object({
  value: z.number().finite().nullable(),
  unit: z.string().min(1),
  comparator: ResultComparatorSchema,
  threshold: z.number().finite().nullable(),
  direction: ResultDirectionSchema,
  precision: z.number().int().min(0).max(12),
  tolerance: z.number().finite().nonnegative(),
  missingness: ResultMissingnessSchema,
  sampleN: z.number().int().nonnegative(),
  nullable: z.boolean(),
  note: z.string().min(1).nullable(),
});

function validateNullableResult(
  value: { value: number | null; nullable: boolean; sampleN: number },
  ctx: z.RefinementCtx,
): void {
  if (value.value === null && (!value.nullable || value.sampleN !== 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'a null scalar value requires nullable=true and sampleN=0',
    });
  }
  if (value.value !== null && value.nullable) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a numeric scalar value requires nullable=false' });
  }
}

export const ScalarResultSchema = ResultFieldsSchema.extend({
  type: z.literal('scalar'),
}).strict().superRefine(validateNullableResult);

export const GroupPointSchema = ResultFieldsSchema.extend({
  type: z.literal('scalar'),
  key: z.string().min(1),
  label: z.string().min(1),
}).strict().superRefine(validateNullableResult);

export const GroupedSeriesResultSchema = ResultFieldsSchema.extend({
  type: z.literal('grouped-series'),
  value: z.null(),
  nullable: z.literal(false),
  groups: z.array(GroupPointSchema).min(1),
}).strict().superRefine((value, ctx) => {
  const keys = new Set<string>();
  for (const group of value.groups) {
    if (keys.has(group.key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate group key: ${group.key}` });
    }
    keys.add(group.key);
    if (group.unit !== value.unit) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `group ${group.key} unit must match series unit` });
    }
  }
});

export const TypedResultSchema = z.union([
  ScalarResultSchema,
  GroupedSeriesResultSchema,
]);

const JsonPrimitiveSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export type JsonValue = z.infer<typeof JsonPrimitiveSchema> | JsonValue[] | { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  JsonPrimitiveSchema,
  z.array(JsonValueSchema),
  z.record(JsonValueSchema),
]));

export const AnalysisResultsSchema = z.object({
  schemaVersion: ResultsSchemaVersionSchema,
  templateId: z.string().min(1),
  templateVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  target: z.object({
    symbol: z.string().min(1),
    name: z.string().min(1),
    entrezGeneId: z.number().int().positive().nullable(),
    gencodeId: z.string().min(1).nullable(),
  }).strict(),
  lockedAnalysis: z.record(JsonValueSchema).refine((value) => Object.keys(value).length > 0, 'lockedAnalysis must not be empty'),
  results: z.record(TypedResultSchema).superRefine((value, ctx) => {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'results must not be empty' });
    }
    for (const [key] of entries) {
      if (!/^[a-z][a-z0-9_.-]*$/.test(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid result key: ${key}` });
      }
    }
  }),
  artifacts: z.array(z.object({
    kind: z.literal('figure'),
    path: z.string().regex(/^[A-Za-z0-9._-]+\.png$/),
    mediaType: z.literal('image/png'),
    description: z.string().min(1),
  }).strict()).min(1),
  warnings: z.array(z.string().min(1)).superRefine((value, ctx) => {
    if (new Set(value).size !== value.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'warnings must be unique' });
    }
  }),
}).strict();

export type ScalarResult = z.infer<typeof ScalarResultSchema>;
export type GroupPoint = z.infer<typeof GroupPointSchema>;
export type GroupedSeriesResult = z.infer<typeof GroupedSeriesResultSchema>;
export type TypedResult = z.infer<typeof TypedResultSchema>;
export type AnalysisResults = z.infer<typeof AnalysisResultsSchema>;

/** Resolve a scalar binding. Grouped-series points use `resultKey::groupKey`. */
export function resolveResultBinding(results: AnalysisResults, resultKey: string): ScalarResult | GroupPoint | undefined {
  const direct = results.results[resultKey];
  if (direct?.type === 'scalar') return direct;

  const separator = resultKey.lastIndexOf('::');
  if (separator < 1) return undefined;
  const series = results.results[resultKey.slice(0, separator)];
  if (series?.type !== 'grouped-series') return undefined;
  return series.groups.find((group) => group.key === resultKey.slice(separator + 2));
}
