import { describe, it, expect } from 'vitest';
import type { TraceEvent } from '@sonny/shared';
import { encodeEvent, encodeNamed } from './sse.js';

describe('sse encoding', () => {
  it('encodes a TraceEvent as a data frame terminated by a blank line', () => {
    const e: TraceEvent = { type: 'evidence_registered', id: 'PMID:1', title: 'X' };
    const frame = encodeEvent(e);
    expect(frame.endsWith('\n\n')).toBe(true);
    expect(frame.startsWith('data: ')).toBe(true);
    expect(JSON.parse(frame.slice('data: '.length).trimEnd())).toEqual(e);
  });

  it('encodes a named event frame', () => {
    const frame = encodeNamed('done', { section: 'hi' });
    expect(frame).toBe('event: done\ndata: {"section":"hi"}\n\n');
  });
});
