import { describe, it, expect } from 'vitest';
import { openTargetsTool } from './openTargets.js';

describe('openTargetsTool', () => {
  it('normalizes a target hit to canonical ENSG evidence', async () => {
    let captured: { url: string; body: unknown } | undefined;
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      captured = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
      return new Response(JSON.stringify({
        data: { search: { hits: [{ id: 'ENSG00000146648', name: 'EGFR', entity: 'target',
          description: 'epidermal growth factor receptor' }] } },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const out = await openTargetsTool.call({ symbol: 'EGFR' }, fakeFetch);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('ENSG00000146648');
    expect(out[0].kind).toBe('target');
    expect(out[0].source).toBe('Open Targets');
    expect(out[0].title).toBe('EGFR');
    expect(captured?.url).toBe('https://api.platform.opentargets.org/api/v4/graphql');
    expect((captured?.body as any).variables.q).toBe('EGFR');
  });

  it('returns zero evidence on empty hits (never fabricates)', async () => {
    const empty = (async () => new Response(JSON.stringify({ data: { search: { hits: [] } } }), { status: 200 })) as unknown as typeof fetch;
    expect(await openTargetsTool.call({ symbol: 'ZZZ' }, empty)).toHaveLength(0);
  });
});
