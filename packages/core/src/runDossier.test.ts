import { describe, it, expect } from 'vitest';
import type { Evidence, TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import type { StructuredModel } from './model.js';
import { runDossier } from './runDossier.js';

const ev: Evidence = { id: 'ENSG1', kind: 'target', source: 'Open Targets', title: 'CDCP1', snippet: 's', url: 'u', raw: {}, retrievedAt: 'now' };
const otTool: Tool = { name: 'open_targets_target', description: '', call: async () => [ev] };
const pubmed: Tool = { name: 'pubmed_search', description: '', call: async () => [] };
const ctgov: Tool = { name: 'clinical_trials_search', description: '', call: async () => [] };

const plannerModel: StructuredModel = { async generateStructured({ schema }) {
  return schema.parse({ selected: ['target_biology'], skipped: [{ id: 'safety_tox', reason: 'no safety question' }] }); } };
const specialistModel: StructuredModel = { async generateStructured({ schema }) {
  return schema.parse({ takeaway: 'CDCP1 is a cell-surface target.',
    claims: [{ id: 'c1', text: 'CDCP1 is a target.', citations: ['ENSG1'], confidence: 0.95 }] }); } };
const verifierModel: StructuredModel = { async generateStructured({ schema }) {
  return schema.parse({ claimId: 'x', status: 'supported', rationale: 'r' }); } };

describe('runDossier', () => {
  it('selects specialists, produces sections sharing one store, and derives a verdict', async () => {
    const events: TraceEvent[] = [];
    const out = await runDossier({
      query: 'CDCP1 biology', symbol: 'CDCP1', tools: [otTool, pubmed, ctgov],
      plannerModel, specialistModel, verifierModel, emit: (e) => events.push(e),
    });
    expect(out.sections.map((s) => s.id)).toEqual(['target_biology']);
    expect(out.verdict).toContain('CDCP1');
    expect(events.find((e) => e.type === 'plan')).toBeTruthy();
    expect(events.find((e) => e.type === 'specialist_skipped')).toBeTruthy();
    expect(events.filter((e) => e.type === 'section_complete')).toHaveLength(1);
  });
});
