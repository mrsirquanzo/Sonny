import { describe, it, expect } from 'vitest';
import type { TraceEvent } from '@sonny/shared';
import { streamRun, type OrchestratorRunner } from './streamRun.js';

describe('streamRun', () => {
  it('writes one frame per emitted event then a done frame', async () => {
    const chunks: string[] = [];
    const runner: OrchestratorRunner = async (emit) => {
      emit({ type: 'plan', specialists: ['target_biology'], tools: ['t'] } as TraceEvent);
      emit({ type: 'evidence_registered', id: 'PMID:1', title: 'X' } as TraceEvent);
      return { verdict: 'done text', sections: [] };
    };
    await streamRun(runner, (c) => chunks.push(c));
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toContain('"type":"plan"');
    expect(chunks[1]).toContain('PMID:1');
    expect(chunks[2]).toContain('"verdict":"done text"');
  });

  it('writes an error frame (message only) when the runner throws', async () => {
    const chunks: string[] = [];
    const runner: OrchestratorRunner = async () => { throw new Error('boom'); };
    await streamRun(runner, (c) => chunks.push(c));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('event: error\ndata: {"message":"boom"}\n\n');
  });
});
