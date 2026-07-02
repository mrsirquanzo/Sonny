import { describe, it, expect } from 'vitest';
import { runPatentWorkup } from './patentWorkup.js';
import type { StructuredModel, Verifier } from '@sonny/core';

// The pipeline calls the model three times, each with a distinct system prompt:
// extractAssociations ("...extract..."), groupConstructs ("...group..."), synthesizeCompetitiveIP (neither).
const model: StructuredModel = {
  async generateStructured(opts: { system: string }) {
    if (opts.system.includes('extract')) return { associations: [{ regionLabel: 'VH', seqId: 1 }] } as never;
    if (opts.system.includes('group')) return { constructs: [{ name: 'Ab1', members: [{ regionLabel: 'VH', seqId: 1 }] }] } as never;
    return { summary: 'ACME antibody.', points: [] } as never;
  },
};

// Mock verifier that passes the narrative through unchanged (for existing tests that don't verify)
const mockVerifier: Verifier = {
  model: { async generateStructured() { return {} as never; } },
  modelId: 'mock', decorrelated: false,
};

describe('runPatentWorkup', () => {
  it('runs the full pipeline and returns a PatentWorkup', async () => {
    const out = await runPatentWorkup('/x.pdf', {
      ingest: async () => ({ markdown: 'Patent US 10,123,456 B2\nClaims\nSEQ ID NO: 1\nEVQLVESGGGLVQPGGSLRLSCAASGFTFSSYAMSWVRQAPGKGLEWVSA\n', status: 'ok' as const }),
      model,
      reconcileDeps: {
        blast: async (_seq: string, database: string) => {
          if (database === 'pataa') return [{ id: 'b1', kind: 'sequence', source: 'blast', title: 'competitor', snippet: '', url: '', raw: { accession: 'PAT_COMP', percentIdentity: 100, queryCoverage: 100, organism: '', alignLen: 51, identity: 51 }, retrievedAt: '' }] as never;
          return [{ id: 'b2', kind: 'sequence', source: 'blast', title: 'human', snippet: '', url: '', raw: { accession: 'NR_12345', percentIdentity: 100, queryCoverage: 100, organism: 'Homo sapiens', alignLen: 51, identity: 51 }, retrievedAt: '' }] as never;
        },
        anarci: async () => ({ overallStatus: 'confirmed', domains: [{ chain: 'H', species: 'homo_sapiens', germline: { v: '', j: '' }, numberedRegions: {} }], regionChecks: [], speciesSummary: [] }),
        epo: async () => ({ input: 'US10123456', found: true, applicants: ['ACME'], inventors: [], ipc: [], family: [] }),
      },
      verifier: mockVerifier,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.workup.patent.applicants).toEqual(['ACME']);
      expect(out.workup.constructs[0]?.name).toBe('Ab1');
      expect(out.workup.graph.some((e) => e.predicate === 'OWNED_BY')).toBe(true);
      expect(out.workup.graph.some((e) => e.predicate === 'MATCHES' && e.object === 'PAT_COMP')).toBe(true);
    }
  });

  it('returns ok:false when markitdown is unavailable', async () => {
    const out = await runPatentWorkup('/x.pdf', { ingest: async () => ({ markdown: '', status: 'markitdown_unavailable' as const, error: 'not installed' }) });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('not installed');
  });

  it('returns ok:false without rejecting when a pipeline tool throws', async () => {
    const out = await runPatentWorkup('/x.pdf', {
      ingest: async () => ({ markdown: 'Patent US 10,123,456 B2\nClaims\nSEQ ID NO: 1\nEVQLVESGGGLVQPGGSLRLSCAASGFTFSSYAMSWVRQAPGKGLEWVSA\n', status: 'ok' as const }),
      model,
      reconcileDeps: {
        blast: async () => { throw new Error('blast service down'); },
        anarci: async () => ({ overallStatus: 'confirmed', domains: [], regionChecks: [], speciesSummary: [] }),
        epo: async () => ({ input: 'US10123456', found: true, applicants: ['ACME'], inventors: [], ipc: [], family: [] }),
      },
      verifier: mockVerifier,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('workup failed');
  });
});

describe('runPatentWorkup narrative verification', () => {
  it('verifies the narrative and carries verdicts + the decorrelated flag', async () => {
    const verifier: Verifier = {
      model: { async generateStructured() { return { status: 'overreach', rationale: '' } as never; } },
      modelId: 'x', decorrelated: false,
    };
    // reuse the happy-path model + ingest from the existing test in this file
    const out = await runPatentWorkup('/x.pdf', {
      ingest: async () => ({ markdown: 'Patent US 10,123,456 B2\nClaims\nSEQ ID NO: 1\nEVQLVESGGGLVQPGGSLRLSCAASGFTFSSYAMSWVRQAPGKGLEWVS\n', status: 'ok' as const }),
      model: { async generateStructured(opts: { system: string }) {
        if (opts.system.includes('extract')) return { associations: [{ regionLabel: 'VH', seqId: 1 }] } as never;
        if (opts.system.includes('group')) return { constructs: [{ name: 'Ab1', members: [{ regionLabel: 'VH', seqId: 1 }] }] } as never;
        return { summary: 'ACME.', points: [{ point: 'market leader', citations: ['SEQ:1'] }] } as never;
      } },
      reconcileDeps: {
        blast: async () => [],
        anarci: async () => ({ overallStatus: 'confirmed', domains: [{ chain: 'H', species: 'homo_sapiens', germline: { v: '', j: '' }, numberedRegions: {} }], regionChecks: [], speciesSummary: [] }),
        epo: async () => ({ input: 'US10123456', found: true, applicants: ['ACME'], inventors: [], ipc: [], family: [] }),
      },
      verifier,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.workup.narrative.decorrelated).toBe(false);
      expect(out.workup.narrative.points[0]?.verdict).toBe('overreach');
    }
  });
});
