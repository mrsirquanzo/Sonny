import type { TraceEvent } from '@sonny/shared';
import { encodeEvent, encodeNamed } from './sse.js';

export type OrchestratorRunner = (emit: (e: TraceEvent) => void) => Promise<{ section: string }>;

export async function streamRun(runner: OrchestratorRunner, write: (chunk: string) => void): Promise<void> {
  try {
    const { section } = await runner((e) => write(encodeEvent(e)));
    write(encodeNamed('done', { section }));
  } catch (err) {
    write(encodeNamed('error', { message: err instanceof Error ? err.message : 'unknown error' }));
  }
}
