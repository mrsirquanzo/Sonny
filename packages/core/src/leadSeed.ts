import type { TraceEvent } from '@sonny/shared';
import type { Tool } from '@sonny/mcp-gateway';
import type { EvidenceStore } from './evidenceStore.js';

// Target-level argument for each structured seed tool.
function seedArgs(toolName: string, target: string): Record<string, unknown> {
  if (toolName === 'open_targets_target') return { symbol: target };
  return { query: target }; // clinical_trials_search and any other structured lookup
}

export async function seedStructuredEvidence(opts: {
  target: string; tools: Tool[]; store: EvidenceStore; emit: (e: TraceEvent) => void;
}): Promise<void> {
  const { target, tools, store, emit } = opts;
  await Promise.all(tools.map(async (t) => {
    const args = seedArgs(t.name, target);
    emit({ type: 'tool_call', tool: t.name, args });
    try {
      const evidence = await t.call(args);
      emit({ type: 'tool_result', tool: t.name, count: evidence.length });
      for (const e of evidence) {
        store.register(e);
        emit({ type: 'evidence_registered', id: e.id, title: e.title });
      }
    } catch (err) {
      emit({ type: 'error', message: `seed ${t.name} failed: ${String(err)}` });
    }
  }));
}
