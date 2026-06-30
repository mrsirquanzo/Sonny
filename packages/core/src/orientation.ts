import type { TraceEvent } from '@sonny/shared';
import type { Tool } from '@sonny/mcp-gateway';
import type { EvidenceStore } from './evidenceStore.js';
import { safeToolCall } from './safeToolCall.js';
import { targetTerms, relevanceGate, titleMentionsTarget } from './relevance.js';
import { buildReviewQuery } from './searchQuery.js';

// Read a review on the target before the specialists run, so the shared store carries
// the broad biology/disease/indication framing a scientist gets from a review first.
export async function orientWithReview(opts: {
  target: string; tools: Tool[]; store: EvidenceStore; emit: (e: TraceEvent) => void;
}): Promise<void> {
  const { target, tools, store, emit } = opts;
  const search = tools.find((t) => t.name === 'europepmc_search');
  const fulltext = tools.find((t) => t.name === 'pmc_fulltext');
  if (!search || !fulltext) return;

  const terms = targetTerms(store, target);
  const query = buildReviewQuery(target);
  emit({ type: 'tool_call', tool: search.name, args: { query } });
  const hits = relevanceGate(await safeToolCall({ tool: search, args: { query }, emit }), terms);
  emit({ type: 'tool_result', tool: search.name, count: hits.length });

  // Register the top K review abstracts as shared orientation evidence.
  const top = hits.slice(0, 2);
  for (const h of top) { store.register(h); emit({ type: 'evidence_registered', id: h.id, title: h.title }); }

  // Deep-read the top open-access review whose title names the target, for the full landscape.
  const readable = top.find((h) =>
    titleMentionsTarget(h, terms) &&
    (h.raw as { pmcid?: string })?.pmcid &&
    (h.raw as { isOpenAccess?: boolean })?.isOpenAccess !== false);
  if (readable) {
    const pmcid = (readable.raw as { pmcid: string }).pmcid;
    emit({ type: 'tool_call', tool: fulltext.name, args: { pmcid } });
    const passages = relevanceGate(await safeToolCall({ tool: fulltext, args: { pmcid }, emit }), terms);
    emit({ type: 'tool_result', tool: fulltext.name, count: passages.length });
    for (const p of passages) {
      store.register(p);
      emit({ type: 'evidence_registered', id: p.id, title: p.title });
      emit({ type: 'research_read', specialist: 'orientation', sourceId: p.id, locator: p.locator ?? p.title });
    }
  }
}
