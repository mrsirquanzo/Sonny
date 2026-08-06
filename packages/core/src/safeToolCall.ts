import type { Evidence, TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';

export function isTransient(err: unknown): boolean {
  const m = String((err as { message?: string })?.message ?? err);
  return /HTTP 5\d\d/.test(m)
    || /HTTP 429/.test(m)
    || /fetch failed/i.test(m)
    || /(timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND)/i.test(m);
}

/**
 * Outcome of a tool call, distinguishing "ran and found nothing" from "failed".
 *
 * `safeToolCall` collapses both to `[]`, which is right for callers that just
 * want evidence but catastrophic for retrieval audits: a timeout recorded as a
 * completed zero-result search is indistinguishable from a real search that
 * found nothing, and that is precisely the record an absence conclusion rests
 * on. A tool outage must never become evidence of absence.
 */
export interface SafeToolCallResult {
  ok: boolean;
  evidence: Evidence[];
  error?: string;
}

export async function safeToolCallResult(opts: {
  tool: Tool; args: Record<string, unknown>; emit: (e: TraceEvent) => void;
  retries?: number; backoffMs?: number; sleep?: (ms: number) => Promise<void>;
}): Promise<SafeToolCallResult> {
  const { tool, args, emit } = opts;
  const retries = opts.retries ?? 2;
  const backoffMs = opts.backoffMs ?? 250;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return { ok: true, evidence: await tool.call(args) };
    } catch (err) {
      lastErr = err;
      if (attempt < retries && isTransient(err)) {
        await sleep(backoffMs * (attempt + 1));
        continue;
      }
      break;
    }
  }
  const error = String(lastErr);
  emit({ type: 'error', message: `tool ${tool.name} failed: ${error}` });
  return { ok: false, evidence: [], error };
}

/** Evidence-only view, for the many callers that cannot act on the distinction. */
export async function safeToolCall(opts: Parameters<typeof safeToolCallResult>[0]): Promise<Evidence[]> {
  return (await safeToolCallResult(opts)).evidence;
}
