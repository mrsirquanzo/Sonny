import type { TraceEvent } from '@mrsirquanzo/sonny-shared';

export function encodeEvent(e: TraceEvent): string {
  return `data: ${JSON.stringify(e)}\n\n`;
}

export function encodeNamed(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
