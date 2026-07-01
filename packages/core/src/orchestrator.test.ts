import { describe, it, expect } from 'vitest';
import type { Evidence, TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import type { StructuredModel } from './model.js';
import { runOrchestration } from './orchestrator.js';

const ev: Evidence = { id: 'ENSG00000146648', kind: 'target', source: 'Open Targets', title: 'EGFR', snippet: 'RTK', url: 'u', raw: {}, retrievedAt: 'now' };
const targetTool: Tool = { name: 'open_targets_search', description: '', call: async () => [ev] };

const specialistModel: StructuredModel = {
  async generateStructured({ schema }) {
    return schema.parse({ claims: [
      { id: 'c1', text: 'EGFR is a receptor tyrosine kinase.', citations: ['ENSG00000146648'], confidence: 0.95 },
      { id: 'c2', text: 'EGFR is unrelated to cancer.', citations: [], confidence: 0.4 },
    ] });
  },
};
const verifierModel: StructuredModel = {
  async generateStructured({ schema }) { return schema.parse({ claimId: 'x', status: 'supported', rationale: 'r' }); },
};

describe('runOrchestration', () => {
  it('runs tools, grounds, verifies, and synthesizes only shipped claims', async () => {
    const events: TraceEvent[] = [];
    const out = await runOrchestration({
      query: 'Is EGFR oncogenic?', symbol: 'EGFR', tools: [targetTool],
      specialistModel, verifierModel, emit: (e) => events.push(e),
    });
    // c2 has no citation -> stripped; only c1 ships and is verified
    expect(out.shipped.map((c) => c.id)).toEqual(['c1']);
    expect(out.verdicts).toHaveLength(1);
    expect(out.section).toContain('receptor tyrosine kinase');
    expect(events.find((e) => e.type === 'plan')).toBeTruthy();
    expect(events.find((e) => e.type === 'evidence_registered')).toBeTruthy();
  });

  it('continues if one tool fails (allSettled)', async () => {
    const boom: Tool = { name: 'bad', description: '', call: async () => { throw new Error('429'); } };
    const events: TraceEvent[] = [];
    const out = await runOrchestration({
      query: 'q', symbol: 'EGFR', tools: [boom, targetTool],
      specialistModel, verifierModel, emit: (e) => events.push(e),
    });
    expect(out.shipped).toHaveLength(1);
    expect(events.find((e) => e.type === 'error')).toBeTruthy();
  });
});
