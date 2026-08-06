import { describe, expect, it } from 'vitest';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import { safeToolCall, safeToolCallResult } from './safeToolCall.js';

const ok: Tool = { name: 'ok_tool', description: '', async call() { return [] as never; } };
const broken: Tool = {
  name: 'broken_tool', description: '',
  async call(): Promise<never> { throw new Error('HTTP 429 rate limited'); },
};

describe('safeToolCallResult separates failure from emptiness', () => {
  it('reports ok for a real search that returned nothing', async () => {
    const r = await safeToolCallResult({ tool: ok, args: {}, emit: () => {} });
    expect(r).toMatchObject({ ok: true, evidence: [] });
  });

  it('reports not-ok, with the error, when the tool failed', async () => {
    const r = await safeToolCallResult({ tool: broken, args: {}, emit: () => {}, retries: 0 });
    expect(r.ok).toBe(false);
    expect(r.evidence).toEqual([]);
    expect(r.error).toMatch(/429/);
  });

  // The evidence-only view stays identical for the many callers that cannot act
  // on the distinction, so this change is additive rather than a migration.
  it('safeToolCall still returns evidence only, empty on failure', async () => {
    expect(await safeToolCall({ tool: broken, args: {}, emit: () => {}, retries: 0 })).toEqual([]);
    expect(await safeToolCall({ tool: ok, args: {}, emit: () => {} })).toEqual([]);
  });
});
