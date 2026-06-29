import type { Evidence, TraceEvent } from '@sonny/shared';
import type { Tool } from '@sonny/mcp-gateway';

export function isTransient(err: unknown): boolean {
  const m = String((err as { message?: string })?.message ?? err);
  return /HTTP 5\d\d/.test(m)
    || /HTTP 429/.test(m)
    || /fetch failed/i.test(m)
    || /(timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND)/i.test(m);
}

export async function safeToolCall(opts: {
  tool: Tool; args: Record<string, unknown>; emit: (e: TraceEvent) => void;
  retries?: number; backoffMs?: number; sleep?: (ms: number) => Promise<void>;
}): Promise<Evidence[]> {
  const { tool, args, emit } = opts;
  const retries = opts.retries ?? 2;
  const backoffMs = opts.backoffMs ?? 250;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await tool.call(args);
    } catch (err) {
      lastErr = err;
      if (attempt < retries && isTransient(err)) {
        await sleep(backoffMs * (attempt + 1));
        continue;
      }
      break;
    }
  }
  emit({ type: 'error', message: `tool ${tool.name} failed: ${String(lastErr)}` });
  return [];
}
