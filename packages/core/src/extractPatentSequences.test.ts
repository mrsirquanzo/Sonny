import { describe, it, expect } from 'vitest';
import { extractPatentSequences } from './extractPatentSequences.js';
import type { StructuredModel } from './model.js';
import type { TraceEvent } from '@mrsirquanzo/sonny-shared';

const model: StructuredModel = {
  async generateStructured() { return { associations: [{ regionLabel: 'CDR-H1', seqId: 1 }] } as never; },
};

describe('extractPatentSequences', () => {
  it('emits patent_ingest ok then the stage events and returns the data', async () => {
    const events: TraceEvent[] = [];
    const ingest = async () => ({ markdown: 'US 10,123,456 B2\nSEQ ID NO: 1\nEVQLVESGGG\n', status: 'ok' as const });
    const out = await extractPatentSequences({ filePath: '/x.pdf', emit: (e) => events.push(e), deps: { ingest, model } });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data.patentNumber).toBe('US10123456');
    expect(events.map((e) => e.type)).toEqual(['patent_ingest', 'patent_extracted', 'patent_associations', 'patent_complete']);
    expect((events[0] as Extract<TraceEvent, { type: 'patent_ingest' }>).status).toBe('ok');
  });

  it('emits error and patent_ingest failed, returns ok:false, on ingest failure', async () => {
    const events: TraceEvent[] = [];
    const ingest = async () => ({ markdown: '', status: 'markitdown_unavailable' as const, error: 'not installed' });
    const out = await extractPatentSequences({ filePath: '/x.pdf', emit: (e) => events.push(e), deps: { ingest } });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('not installed');
    expect(events.map((e) => e.type)).toEqual(['error', 'patent_ingest']);
    expect((events[1] as Extract<TraceEvent, { type: 'patent_ingest' }>).status).toBe('failed');
  });
});
