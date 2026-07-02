import { describe, it, expect } from 'vitest';
import { runExtractPatent } from './extractPatent.js';
import type { StructuredModel } from '@mrsirquanzo/sonny-core';

const model: StructuredModel = {
  async generateStructured() { return { associations: [{ regionLabel: 'CDR-H1', seqId: 1 }] } as never; },
};

describe('runExtractPatent', () => {
  it('ingests then extracts, returning the ExtractedPatent', async () => {
    const ingest = async () => ({ markdown: 'US 10,123,456 B2\nSEQ ID NO: 1\nEVQLVESGGG\n', status: 'ok' as const });
    const out = await runExtractPatent('/x.pdf', { ingest, model });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.patentNumber).toBe('US10123456');
      expect(out.data.associations[0]).toEqual({ regionLabel: 'CDR-H1', seqId: 1, residues: 'EVQLVESGGG' });
    }
  });

  it('returns ok:false when markitdown is unavailable', async () => {
    const ingest = async () => ({ markdown: '', status: 'markitdown_unavailable' as const, error: 'not installed' });
    const out = await runExtractPatent('/x.pdf', { ingest });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('not installed');
  });
});
