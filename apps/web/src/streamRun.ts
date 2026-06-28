import type { Section, TraceEvent } from '@sonny/shared';
import { encodeEvent, encodeNamed } from './sse.js';

export type OrchestratorRunner = (emit: (e: TraceEvent) => void) => Promise<{ verdict: string; sections: Section[] }>;

export async function streamRun(runner: OrchestratorRunner, write: (chunk: string) => void): Promise<void> {
  try {
    const result = await runner((e) => write(encodeEvent(e)));
    write(encodeNamed('done', result));
  } catch (err) {
    write(encodeNamed('error', { message: err instanceof Error ? err.message : 'unknown error' }));
  }
}
