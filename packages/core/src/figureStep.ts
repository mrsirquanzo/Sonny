import type { TraceEvent, FigureReading } from '@mrsirquanzo/sonny-shared';
import type { Tool, ReadFiguresOpts } from '@mrsirquanzo/sonny-mcp-gateway';
import { pmcFiguresTool, readFigures } from '@mrsirquanzo/sonny-mcp-gateway';
import type { EvidenceStore } from './evidenceStore.js';
import { safeToolCall } from './safeToolCall.js';

export interface FigureDeps {
  tool: Tool;
  read: (o: ReadFiguresOpts) => Promise<FigureReading[]>;
}

const DEFAULT_DEPS: FigureDeps = { tool: pmcFiguresTool, read: readFigures };

export async function researchFigures(opts: {
  pmcid: string;
  question: string;
  store: EvidenceStore;
  emit: (e: TraceEvent) => void;
  specialist: string;
  deps?: FigureDeps;
}): Promise<FigureReading[]> {
  const deps = opts.deps ?? DEFAULT_DEPS;
  // pmc_figures is a Tool returning Evidence[]; safeToolCall degrades it to [] on failure.
  const figs = await safeToolCall({ tool: deps.tool, args: { pmcid: opts.pmcid }, emit: opts.emit });
  if (figs.length === 0) return [];
  for (const f of figs) {
    opts.store.register(f);
    opts.emit({ type: 'evidence_registered', id: f.id, title: f.title });
  }
  const figures = figs.map((f) => ({ figureId: f.id, imageUrl: f.url, caption: f.passage ?? '' }));
  let readings: FigureReading[] = [];
  try {
    readings = await deps.read({ question: opts.question, figures });
  } catch (err) {
    // Figures are additive, never load-bearing: degrade to text-only.
    opts.emit({ type: 'error', message: `figure_read failed: ${String(err)}` });
    return [];
  }
  opts.emit({ type: 'figure_read', specialist: opts.specialist, readings });
  return readings;
}
