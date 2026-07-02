import { describe, it, expect } from 'vitest';
import type { Evidence } from '@mrsirquanzo/sonny-shared';
import type { StructuredModel } from '../model.js';
import { runSkepticAudit } from './skepticAudit.js';

const paper: Evidence = {
  id: 'PMID:1', kind: 'publication', source: 'Europe PMC',
  title: 'A single-arm study of drug X', snippet: '', passage: 'Open-label, single arm, n=42. eGFR improved in a post-hoc subgroup.',
  url: 'u', raw: {}, retrievedAt: 'now',
};

describe('runSkepticAudit', () => {
  it('returns a critique whose evidenceId is the paper id, with the model flags passed through', async () => {
    let system = '';
    const model: StructuredModel = {
      async generateStructured(opts) {
        system = opts.system;
        return { studyDesign: 'post_hoc', sampleSize: 42,
          redFlags: [{ category: 'surrogate_endpoint', biasRisk: 'high', explanation: 'eGFR is a surrogate endpoint.' }] } as never;
      },
    };
    const critique = await runSkepticAudit(paper, model);
    expect(critique.evidenceId).toBe('PMID:1');          // id set in code, not by the model
    expect(critique.studyDesign).toBe('post_hoc');
    expect(critique.redFlags[0].biasRisk).toBe('high');
    expect(system.toLowerCase()).toContain('dropout');   // prompt scrutinizes design/reporting
    expect(system.toLowerCase()).toContain('endpoint');
  });

  it('returns an empty redFlags list when the model finds none', async () => {
    const model: StructuredModel = {
      async generateStructured() { return { studyDesign: 'in_vitro', sampleSize: null, redFlags: [] } as never; },
    };
    const critique = await runSkepticAudit(paper, model);
    expect(critique.redFlags).toEqual([]);
    expect(critique.evidenceId).toBe('PMID:1');
  });
});
