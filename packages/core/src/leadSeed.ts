import type { TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import type { EvidenceStore } from './evidenceStore.js';
import { resolveTargetIdentity } from './parseQuery.js';

// Target-level argument for each structured seed tool.
//
// Symbol-keyed tools receive the RETRIEVAL SYMBOL, never the raw target string:
// "KRAS G12C" resolves to symbol KRAS, so the lookup matches instead of
// silently returning nothing.
function seedArgs(toolName: string, symbol: string): Record<string, unknown> {
  if (toolName === 'open_targets_target') return { symbol };
  return { query: symbol }; // clinical_trials_search and any other structured lookup
}

/**
 * Every symbol a target should be looked up under.
 *
 * A fusion has TWO partners and both are real genes with their own Open Targets
 * and trial records; seeding only the first silently halves the structured
 * evidence for every fusion target.
 */
export function seedSymbolsFor(target: string): string[] {
  const identity = resolveTargetIdentity(target);
  switch (identity.kind) {
    case 'gene_or_protein': return [identity.symbol];
    case 'peptide_hla':     return [identity.sourceGene];
    case 'fusion':          return [identity.partners[0], identity.partners[1]];
    case 'other':           return [target];
  }
}

export async function seedStructuredEvidence(opts: {
  target: string; tools: Tool[]; store: EvidenceStore; emit: (e: TraceEvent) => void;
}): Promise<void> {
  const { target, tools, store, emit } = opts;
  const symbols = seedSymbolsFor(target);
  await Promise.all(tools.flatMap((t) => symbols.map(async (symbol) => {
    const args = seedArgs(t.name, symbol);
    emit({ type: 'tool_call', tool: t.name, args });
    try {
      const evidence = await t.call(args);
      emit({ type: 'tool_result', tool: t.name, count: evidence.length });
      for (const e of evidence) {
        store.register(e);
        emit({ type: 'evidence_registered', id: e.id, title: e.title });
      }
    } catch (err) {
      emit({ type: 'error', message: `seed ${t.name} (${symbol}) failed: ${String(err)}` });
    }
  })));
}
