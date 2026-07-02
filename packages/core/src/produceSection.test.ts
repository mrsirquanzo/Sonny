import { describe, it, expect } from 'vitest';
import type { Evidence, TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import type { StructuredModel } from './model.js';
import { EvidenceStore } from './evidenceStore.js';
import { produceSection } from './produceSection.js';
import { SPECIALISTS } from './specialists.js';

const ev: Evidence = { id: 'ENSG1', kind: 'target', source: 'Open Targets', title: 'CDCP1', snippet: 's', url: 'u', raw: {}, retrievedAt: 'now' };
const otTool: Tool = { name: 'open_targets_target', description: '', call: async () => [ev] };
const pubmed: Tool = { name: 'pubmed_search', description: '', call: async () => [] };

const specialistModel: StructuredModel = {
  async generateStructured({ schema }) {
    return schema.parse({ takeaway: 'CDCP1 is a cell-surface target.',
      claims: [{ id: 'c1', text: 'CDCP1 is a target.', citations: ['ENSG1'], confidence: 0.9 }] });
  },
};
const verifierModel: StructuredModel = { async generateStructured({ schema }) { return schema.parse({ claimId: 'x', status: 'supported', rationale: 'r' }); } };

describe('produceSection', () => {
  it('runs tools, grounds, verifies, rates, and returns a section', async () => {
    const events: TraceEvent[] = [];
    const spec = SPECIALISTS.find((s) => s.id === 'target_biology')!;
    const section = await produceSection({
      spec, query: 'CDCP1 biology', symbol: 'CDCP1', tools: [otTool, pubmed],
      store: new EvidenceStore(), specialistModel, verifierModel, emit: (e) => events.push(e),
    });
    expect(section.id).toBe('target_biology');
    expect(section.title).toBe('Target Biology');
    expect(section.takeaway).toContain('cell-surface');
    expect(section.claims.map((c) => c.id)).toEqual(['c1']);
    expect(section.sources).toContain('ENSG1');
    expect(section.rag).toBe('amber'); // one source -> amber
    expect(events.find((e) => e.type === 'specialist_start')).toBeTruthy();
    expect(events.find((e) => e.type === 'section_complete')).toBeTruthy();
  });
});
