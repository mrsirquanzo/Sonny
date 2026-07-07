import { describe, it, expect } from 'vitest';
import { extractPatentSequences, isReadableMarkdown } from './extractPatentSequences.js';
import type { StructuredModel } from './model.js';
import type { TraceEvent } from '@mrsirquanzo/sonny-shared';

const model: StructuredModel = {
  async generateStructured() { return { associations: [{ regionLabel: 'CDR-H1', seqId: 1 }] } as never; },
};

describe('extractPatentSequences', () => {
  it('emits patent_ingest ok then the stage events and returns the data', async () => {
    const events: TraceEvent[] = [];
    const ingest = async () => ({ markdown: 'US 10,123,456 B2\nSEQ ID NO: 1\nEVQLVESGGG\nThis is a patent describing a method of treatment with extensive technical disclosure that makes it readable and substantive.\n', status: 'ok' as const });
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

  it('catches a thrown ingest, emits error + patent_ingest failed, returns ok:false', async () => {
    const events: TraceEvent[] = [];
    const ingest = async () => { throw new Error('boom'); };
    const out = await extractPatentSequences({ filePath: '/x.pdf', emit: (e) => events.push(e), deps: { ingest } });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('boom');
    expect(events.map((e) => e.type)).toEqual(['error', 'patent_ingest']);
    expect((events[1] as Extract<TraceEvent, { type: 'patent_ingest' }>).status).toBe('failed');
  });
});

describe('isReadableMarkdown', () => {
  it('is false for empty, whitespace, or near-empty text and true above the floor', () => {
    expect(isReadableMarkdown('')).toBe(false);
    expect(isReadableMarkdown('   \n \t ')).toBe(false);
    expect(isReadableMarkdown('A')).toBe(false);
    expect(isReadableMarkdown('x'.repeat(60))).toBe(true);
    expect(isReadableMarkdown('  ' + 'x'.repeat(60) + '  \n')).toBe(true);
  });
});

describe('extractPatentSequences unreadable ingest', () => {
  it('fails explicitly when ingest is ok but the document has no extractable text', async () => {
    const events: TraceEvent[] = [];
    let modelCalls = 0;
    const model: StructuredModel = { async generateStructured() { modelCalls++; return { associations: [] } as never; } };
    const ingest = async () => ({ markdown: '\n \n', status: 'ok' as const });
    const out = await extractPatentSequences({ filePath: '/scan.pdf', emit: (e) => events.push(e), deps: { ingest, model } });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('OCR');
    expect(events.map((e) => e.type)).toEqual(['error', 'patent_ingest']);
    expect((events[1] as Extract<TraceEvent, { type: 'patent_ingest' }>).status).toBe('failed');
    expect(modelCalls).toBe(0);
  });

  it('does NOT flag a readable document that simply has no sequences', async () => {
    const events: TraceEvent[] = [];
    const prose = 'This patent describes a method of treatment. '.repeat(20); // long, readable, no SEQ IDs
    const model: StructuredModel = { async generateStructured() { return { associations: [] } as never; } };
    const ingest = async () => ({ markdown: prose, status: 'ok' as const });
    const out = await extractPatentSequences({ filePath: '/x.pdf', emit: (e) => events.push(e), deps: { ingest, model } });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data.sequences.length).toBe(0);
    expect(events[0].type).toBe('patent_ingest');
    expect((events[0] as Extract<TraceEvent, { type: 'patent_ingest' }>).status).toBe('ok');
  });
});
