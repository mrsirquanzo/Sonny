import { describe, it, expect } from 'vitest';
import type { Tool } from '@sonny/mcp-gateway';
import type { TraceEvent, Evidence } from '@sonny/shared';
import { safeToolCall, isTransient } from './safeToolCall.js';

const ev: Evidence = { id: 'PMID:1', kind: 'publication', source: 's', title: 't', snippet: '', url: 'u', raw: {}, retrievedAt: 'now' };
const noSleep = async () => {};

describe('isTransient', () => {
  it('classifies 5xx, 429, and network errors as transient; 4xx as not', () => {
    expect(isTransient(new Error('Europe PMC HTTP 504'))).toBe(true);
    expect(isTransient(new Error('Open Targets HTTP 429'))).toBe(true);
    expect(isTransient(new Error('fetch failed'))).toBe(true);
    expect(isTransient(new Error('ECONNRESET'))).toBe(true);
    expect(isTransient(new Error('Open Targets HTTP 400'))).toBe(false);
  });
});

describe('safeToolCall', () => {
  it('returns evidence on success without retrying', async () => {
    let calls = 0;
    const tool: Tool = { name: 'x', description: '', async call() { calls++; return [ev]; } };
    const out = await safeToolCall({ tool, args: {}, emit: () => {}, sleep: noSleep });
    expect(out).toEqual([ev]);
    expect(calls).toBe(1);
  });

  it('retries a transient failure then succeeds', async () => {
    let calls = 0;
    const tool: Tool = { name: 'x', description: '', async call() { calls++; if (calls < 2) throw new Error('HTTP 504'); return [ev]; } };
    const out = await safeToolCall({ tool, args: {}, emit: () => {}, sleep: noSleep });
    expect(out).toEqual([ev]);
    expect(calls).toBe(2);
  });

  it('gives up after 2 retries on persistent transient failure, emits error, returns []', async () => {
    let calls = 0;
    const events: TraceEvent[] = [];
    const tool: Tool = { name: 'x', description: '', async call() { calls++; throw new Error('HTTP 504'); } };
    const out = await safeToolCall({ tool, args: {}, emit: (e) => events.push(e), sleep: noSleep });
    expect(out).toEqual([]);
    expect(calls).toBe(3); // 1 + 2 retries
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('does NOT retry a non-transient failure; emits error and returns [] immediately', async () => {
    let calls = 0;
    const events: TraceEvent[] = [];
    const tool: Tool = { name: 'x', description: '', async call() { calls++; throw new Error('HTTP 400'); } };
    const out = await safeToolCall({ tool, args: {}, emit: (e) => events.push(e), sleep: noSleep });
    expect(out).toEqual([]);
    expect(calls).toBe(1);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});
