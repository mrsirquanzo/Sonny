import type { Evidence, TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import type { StructuredModel } from './model.js';
import { buildSearchQuery } from './searchQuery.js';
import { relevanceGate } from './relevance.js';
import { safeToolCall } from './safeToolCall.js';
import { cosineSimilarity, OllamaEmbeddings } from './embeddings.js';
import { rewriteResearchQuery, type ResearchQueryVariant } from './queryRewrite.js';
import { rerankResearchHits } from './rerankStep.js';

const DEFAULT_RRF_K = 60;
const DEFAULT_CANDIDATE_LIMIT = 50;

export interface RankedList<T> { items: T[] }

export function reciprocalRankFusion<T>(
  lists: RankedList<T>[],
  key: (item: T) => string,
  k = DEFAULT_RRF_K,
): T[] {
  const scores = new Map<string, { item: T; score: number; first: number }>();
  let ordinal = 0;
  for (const list of lists) {
    const seen = new Set<string>();
    list.items.forEach((item, index) => {
      const id = key(item);
      if (seen.has(id)) return;
      seen.add(id);
      const current = scores.get(id) ?? { item, score: 0, first: ordinal++ };
      current.score += 1 / (Math.max(0, k) + index + 1);
      scores.set(id, current);
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.first - b.first)
    .map(({ item }) => item);
}

export function hybridRetrievalEnabled(value = process.env.SONNY_HYBRID_RETRIEVAL): boolean {
  return value !== 'off' && value !== 'false' && value !== '0';
}

function positiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 1), max) : fallback;
}

function evidenceText(hit: Evidence): string {
  return `${hit.title}\n${hit.passage ?? hit.snippet}`.trim();
}

export interface RetrieveResearchHitsOptions {
  specialist: string;
  target: string;
  question: string;
  concept: string;
  terms: string[];
  search: Tool;
  model: StructuredModel;
  emit: (event: TraceEvent) => void;
  hybrid?: boolean;
  pageSize?: number;
  topK?: number;
  embeddings?: Pick<OllamaEmbeddings, 'model' | 'embed'>;
  rewrite?: typeof rewriteResearchQuery;
  rerank?: (opts: { question: string; hits: Evidence[] }) => Promise<Evidence[]>;
}

/** Retrieve, union, fuse, then pass the fused pool into the existing reranker. */
export async function retrieveResearchHits(opts: RetrieveResearchHitsOptions): Promise<Evidence[]> {
  const hybrid = opts.hybrid ?? hybridRetrievalEnabled();
  const topK = opts.topK ?? positiveInt(process.env.SONNY_RETRIEVAL_TOP_K, 8, 100);
  const rerankOn = process.env.SONNY_RERANK !== 'off' && (!!process.env.SONNY_RERANK_API_KEY || !!opts.rerank);

  if (!hybrid) {
    const query = buildSearchQuery(opts.target, opts.concept);
    opts.emit({ type: 'tool_call', tool: opts.search.name, args: { query } });
    const raw = await safeToolCall({
      tool: opts.search,
      args: { query, pageSize: opts.pageSize ?? (rerankOn ? 25 : topK) },
      emit: opts.emit,
    });
    const gated = relevanceGate(raw, opts.terms);
    const ranked = rerankOn
      ? await rerankResearchHits({ specialist: opts.specialist, question: opts.question, hits: gated, emit: opts.emit, rerank: opts.rerank })
      : gated;
    return ranked.slice(0, topK);
  }

  let variants: ResearchQueryVariant[] = [{ target: opts.target, concept: opts.concept }];
  try {
    variants = await (opts.rewrite ?? rewriteResearchQuery)({
      target: opts.target,
      targetAliases: opts.terms,
      question: opts.question,
      concept: opts.concept,
      model: opts.model,
    });
  } catch (error) {
    opts.emit({ type: 'error', message: `query rewrite failed: ${String(error)}` });
  }
  opts.emit({
    type: 'query_rewrite', specialist: opts.specialist, question: opts.question,
    variants: variants.map((variant) => buildSearchQuery(variant.target, variant.concept)),
  });

  const pageSize = opts.pageSize ?? positiveInt(process.env.SONNY_HYBRID_PAGE_SIZE, 25, 100);
  const lexicalLists: Evidence[][] = [];
  for (const variant of variants) {
    const query = buildSearchQuery(variant.target, variant.concept);
    opts.emit({ type: 'tool_call', tool: opts.search.name, args: { query } });
    const raw = await safeToolCall({ tool: opts.search, args: { query, pageSize }, emit: opts.emit });
    lexicalLists.push(relevanceGate(raw, opts.terms));
  }
  const lexical = reciprocalRankFusion(
    lexicalLists.map((items) => ({ items })),
    (hit) => hit.id,
    positiveInt(process.env.SONNY_RRF_K, DEFAULT_RRF_K, 1000),
  ).slice(0, positiveInt(process.env.SONNY_HYBRID_CANDIDATES, DEFAULT_CANDIDATE_LIMIT, 200));
  if (lexical.length < 2) return lexical.slice(0, topK);

  let fused = lexical;
  try {
    const embedder = opts.embeddings ?? new OllamaEmbeddings();
    const [questionVector, ...candidateVectors] = await embedder.embed([
      opts.question,
      ...lexical.map(evidenceText),
    ]);
    const dense = lexical
      .map((hit, index) => ({ hit, score: cosineSimilarity(questionVector, candidateVectors[index]) }))
      .sort((a, b) => b.score - a.score)
      .map(({ hit }) => hit);
    fused = reciprocalRankFusion(
      [{ items: lexical }, { items: dense }],
      (hit) => hit.id,
      positiveInt(process.env.SONNY_RRF_K, DEFAULT_RRF_K, 1000),
    );
    opts.emit({ type: 'dense_score', specialist: opts.specialist, model: embedder.model, candidates: lexical.length });
    opts.emit({ type: 'fusion', specialist: opts.specialist, before: lexical.map((h) => h.id), after: fused.map((h) => h.id) });
  } catch (error) {
    opts.emit({ type: 'error', message: `dense retrieval failed; using lexical union: ${String(error)}` });
  }

  // Hybrid retrieval always feeds the existing cross-encoder stage when it is
  // configured. Its own graceful fallback preserves the fused order.
  const rerankInput = fused.slice(0, topK);
  const finalRanked = rerankOn
    ? await rerankResearchHits({ specialist: opts.specialist, question: opts.question, hits: rerankInput, emit: opts.emit, rerank: opts.rerank })
    : rerankInput;
  return finalRanked.slice(0, topK);
}
