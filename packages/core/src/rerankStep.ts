import type { Evidence, TraceEvent } from '@mrsirquanzo/sonny-shared';
import { rerankHits } from '@mrsirquanzo/sonny-mcp-gateway';

export async function rerankResearchHits(opts: {
  specialist: string;
  question: string;
  hits: Evidence[];
  emit: (e: TraceEvent) => void;
  rerank?: (o: { question: string; hits: Evidence[] }) => Promise<Evidence[]>;
}): Promise<Evidence[]> {
  const { specialist, question, hits, emit } = opts;
  if (hits.length < 2) return hits;
  const rerank = opts.rerank ?? ((o) => rerankHits(o));
  try {
    const ranked = await rerank({ question, hits });
    emit({ type: 'rerank', specialist, before: hits.map((h) => h.id), after: ranked.map((h) => h.id) });
    return ranked;
  } catch (err) {
    // Reranking is additive; degrade to the citation-ordered hits.
    emit({ type: 'error', message: `rerank failed: ${String(err)}` });
    return hits;
  }
}
