import type { Evidence } from '@mrsirquanzo/sonny-shared';

const DEFAULT_ENDPOINT = 'https://api.cohere.com/v2/rerank';
const DEFAULT_MODEL = 'rerank-v3.5';

export interface RerankOpts {
  question: string;
  hits: Evidence[];
  topN?: number;
  endpoint?: string;
  model?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

interface RerankItem { index: number; relevance_score: number }

// Reorder hits by a hosted cross-encoder's relevance to the question. Provider-agnostic:
// endpoint/model/key are configurable and the response is parsed leniently (results|data).
export async function rerankHits(opts: RerankOpts): Promise<Evidence[]> {
  const { question, hits } = opts;
  if (hits.length < 2) return hits;

  const endpoint = opts.endpoint ?? process.env.SONNY_RERANK_ENDPOINT ?? DEFAULT_ENDPOINT;
  const model = opts.model ?? process.env.SONNY_RERANK_MODEL ?? DEFAULT_MODEL;
  const apiKey = opts.apiKey ?? process.env.SONNY_RERANK_API_KEY;
  if (!apiKey) throw new Error('rerank: no API key (set SONNY_RERANK_API_KEY)');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const topN = opts.topN ?? hits.length;

  const documents = hits.map((h) => `${h.title}\n${h.passage ?? h.snippet}`);
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, query: question, documents, top_n: topN }),
  });
  if (!res.ok) throw new Error(`rerank HTTP ${res.status}`);

  const body = (await res.json()) as { results?: RerankItem[]; data?: RerankItem[] };
  const ranked = (body.results ?? body.data ?? [])
    .filter((r) => Number.isInteger(r.index) && r.index >= 0 && r.index < hits.length)
    .sort((a, b) => b.relevance_score - a.relevance_score);

  const seen = new Set<number>();
  const out: Evidence[] = [];
  for (const r of ranked) {
    if (seen.has(r.index)) continue;
    seen.add(r.index);
    out.push(hits[r.index]);
  }
  // Any hit the response did not name is appended in original order - no candidate lost.
  hits.forEach((h, i) => { if (!seen.has(i)) out.push(h); });
  return out;
}
