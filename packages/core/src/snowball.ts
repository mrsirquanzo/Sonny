import type { Evidence, TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import type { EvidenceStore } from './evidenceStore.js';
import { safeToolCall } from './safeToolCall.js';
import { relevanceGate } from './relevance.js';

// Follow forward citations of a seed paper one hop: title-gate the citers (they carry
// no abstract), hydrate the top 3 via EXT_ID search to get abstract + pmcid, register.
export async function snowballCitations(opts: {
  seed: Evidence; terms: string[]; tools: Tool[]; store: EvidenceStore; emit: (e: TraceEvent) => void;
}): Promise<void> {
  const { seed, terms, tools, store, emit } = opts;
  const citationsTool = tools.find((t) => t.name === 'europepmc_citations');
  const search = tools.find((t) => t.name === 'europepmc_search');
  if (!citationsTool || !search) return;
  const pmid = seed.id.replace(/^PMID:/, '');
  if (!pmid || pmid === seed.id) return; // seed is not a PMID-keyed paper

  emit({ type: 'tool_call', tool: citationsTool.name, args: { pmid } });
  const citers = relevanceGate(await safeToolCall({ tool: citationsTool, args: { pmid }, emit }), terms);
  emit({ type: 'tool_result', tool: citationsTool.name, count: citers.length });

  for (const c of citers.slice(0, 3)) {
    const extId = c.id.replace(/^PMID:/, '');
    const query = `EXT_ID:${extId} AND SRC:MED`;
    emit({ type: 'tool_call', tool: search.name, args: { query } });
    const hydrated = relevanceGate(await safeToolCall({ tool: search, args: { query }, emit }), terms);
    emit({ type: 'tool_result', tool: search.name, count: hydrated.length });
    for (const h of hydrated) { store.register(h); emit({ type: 'evidence_registered', id: h.id, title: h.title }); }
  }
}
