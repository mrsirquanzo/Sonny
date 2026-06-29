import { describe, it, expect } from 'vitest';
import type { Tool } from '@sonny/mcp-gateway';
import type { TraceEvent } from '@sonny/shared';
import { EvidenceStore } from './evidenceStore.js';
import { seedStructuredEvidence } from './leadSeed.js';

function tool(name: string, recordArgs: Record<string, unknown>[], evidence: object[]): Tool {
  return { name, description: name, async call(args) { recordArgs.push(args); return evidence as never; } };
}

describe('seedStructuredEvidence', () => {
  it('calls open_targets_target with the symbol and clinical_trials_search with the target, seeding the shared store', async () => {
    const otArgs: Record<string, unknown>[] = [];
    const ctArgs: Record<string, unknown>[] = [];
    const ot = tool('open_targets_target', otArgs, [
      { id: 'ENSG1', kind: 'target', source: 'Open Targets', title: 'CDCP1', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);
    const ct = tool('clinical_trials_search', ctArgs, [
      { id: 'NCT1', kind: 'trial', source: 'ClinicalTrials.gov', title: 'A trial', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);
    const store = new EvidenceStore();
    const events: TraceEvent[] = [];
    await seedStructuredEvidence({ target: 'CDCP1', tools: [ot, ct], store, emit: (e) => events.push(e) });

    expect(otArgs).toEqual([{ symbol: 'CDCP1' }]);
    expect(ctArgs).toEqual([{ query: 'CDCP1' }]);
    expect(store.has('ENSG1')).toBe(true);
    expect(store.has('NCT1')).toBe(true);
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(2);
  });

  it('reports a failing seed tool as an error event and still seeds the others', async () => {
    const ok = tool('clinical_trials_search', [], [
      { id: 'NCT1', kind: 'trial', source: 'ClinicalTrials.gov', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' },
    ]);
    const bad: Tool = { name: 'open_targets_target', description: 'x', async call() { throw new Error('HTTP 400'); } };
    const store = new EvidenceStore();
    const events: TraceEvent[] = [];
    await seedStructuredEvidence({ target: 'CDCP1', tools: [bad, ok], store, emit: (e) => events.push(e) });
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(store.has('NCT1')).toBe(true);
  });
});
