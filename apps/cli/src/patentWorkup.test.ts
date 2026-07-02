import { describe, it, expect } from 'vitest';
import { runPatentWorkup } from './patentWorkup.js';
import type { StructuredModel } from '@sonny/core';

// The pipeline calls the model three times, each with a distinct system prompt:
// extractAssociations ("...extract..."), groupConstructs ("...group..."), synthesizeCompetitiveIP (neither).
const model: StructuredModel = {
  async generateStructured(opts: { system: string }) {
    if (opts.system.includes('extract')) return { associations: [{ regionLabel: 'VH', seqId: 1 }] } as never;
    if (opts.system.includes('group')) return { constructs: [{ name: 'Ab1', members: [{ regionLabel: 'VH', seqId: 1 }] }] } as never;
    return { summary: 'ACME antibody.', points: [] } as never;
  },
};

describe('runPatentWorkup', () => {
  it('runs the full pipeline and returns a PatentWorkup', async () => {
    const out = await runPatentWorkup('/x.pdf', {
      ingest: async () => ({ markdown: 'Patent US 10,123,456 B2\nClaims\nSEQ ID NO: 1\nEVQLVESGGGLVQPGGSLRLSCAASGFTFSSYAMSWVRQAPGKGLEWVS\n', status: 'ok' as const }),
      model,
      reconcileDeps: {
        blast: async () => [],
        anarci: async () => ({ overallStatus: 'confirmed', domains: [{ chain: 'H', species: 'homo_sapiens', germline: { v: '', j: '' }, numberedRegions: {} }], regionChecks: [], speciesSummary: [] }),
        epo: async () => ({ input: 'US10123456', found: true, applicants: ['ACME'], inventors: [], ipc: [], family: [] }),
      },
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.workup.patent.applicants).toEqual(['ACME']);
      expect(out.workup.constructs[0]?.name).toBe('Ab1');
      expect(out.workup.graph.some((e) => e.predicate === 'OWNED_BY')).toBe(true);
    }
  });

  it('returns ok:false when markitdown is unavailable', async () => {
    const out = await runPatentWorkup('/x.pdf', { ingest: async () => ({ markdown: '', status: 'markitdown_unavailable' as const, error: 'not installed' }) });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('not installed');
  });
});
