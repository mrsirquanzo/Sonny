import {
  FiguresAnalyzeResponseSchema, FigureTypeSchema,
  type FigureReading, type FigureType,
} from '@mrsirquanzo/sonny-shared';

// Normalize a numeric-bearing string so 0.620 == 0.62, 1,234 == 1234, 0·62 == 0.62.
// A false "high" (missed match) is the safe direction; never launder high -> low.
export function normalizeNumeric(s: string): string {
  return s
    .toLowerCase()
    .replace(/·/g, '.')                 // middle dot -> decimal point
    .replace(/(\d),(?=\d{3}(\D|$))/g, '$1')  // thousands separators: 1,234 -> 1234
    .replace(/(\d+\.\d*?)0+(?=\D|$)/g, '$1') // strip trailing zeros: 0.620 -> 0.62
    .replace(/(\d+)\.(?=\D|$)/g, '$1');      // strip bare trailing dot: 5. -> 5
}

export function captionContainsValue(caption: string, value: string): boolean {
  const v = normalizeNumeric(value.trim());
  if (!v) return false;
  return normalizeNumeric(caption).includes(v);
}

export interface FigureInput { figureId: string; imageUrl: string; caption: string }

export interface ReadFiguresOpts {
  question: string;
  figures: FigureInput[];
  topK?: number;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

export async function readFigures(opts: ReadFiguresOpts): Promise<FigureReading[]> {
  const { question, figures } = opts;
  if (figures.length === 0) return [];
  const topK = opts.topK ?? 3;
  const endpoint = opts.endpoint ?? process.env.SONNY_FIGURES_SIDECAR ?? 'http://localhost:8077';
  const fetchImpl = opts.fetchImpl ?? fetch;

  const res = await fetchImpl(`${endpoint}/figures/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question, figures, topK }),
  });
  if (!res.ok) throw new Error(`figure sidecar HTTP ${res.status}`);

  const parsed = FiguresAnalyzeResponseSchema.parse(await res.json());
  const captionById = new Map(figures.map((f) => [f.figureId, f.caption]));

  const out: FigureReading[] = [];
  for (const r of parsed.readings) {
    // Grounding: only accept a figureId we actually sent; evidenceId is set from our input.
    const caption = captionById.get(r.figureId);
    if (caption === undefined) continue;
    const extractedValues = r.extractedValues.map((v) => {
      const inCaption = captionContainsValue(caption, v.value);
      return { label: v.label, value: v.value, unit: v.unit, inCaption, readRisk: inCaption ? 'low' as const : 'high' as const };
    });
    const figureType: FigureType = FigureTypeSchema.safeParse(r.figureType).success
      ? (r.figureType as FigureType) : 'other';
    out.push({ evidenceId: r.figureId, figureType, reading: r.reading, extractedValues, confidence: r.confidence });
  }
  return out;
}
