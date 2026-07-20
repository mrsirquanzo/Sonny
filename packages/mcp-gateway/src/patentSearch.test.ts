import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetTokenCache } from './epoPatent.js';
import { patentSearchTool } from './patentSearch.js';

const originalKey = process.env.SONNY_EPO_KEY;
const originalSecret = process.env.SONNY_EPO_SECRET;
const originalBase = process.env.SONNY_EPO_BASE;

function restoreEnv(name: 'SONNY_EPO_KEY' | 'SONNY_EPO_SECRET' | 'SONNY_EPO_BASE', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  resetTokenCache();
});

afterEach(() => {
  restoreEnv('SONNY_EPO_KEY', originalKey);
  restoreEnv('SONNY_EPO_SECRET', originalSecret);
  restoreEnv('SONNY_EPO_BASE', originalBase);
  resetTokenCache();
});

const SEARCH_RESULT = {
  'ops:world-patent-data': {
    'ops:biblio-search': {
      'ops:search-result': {
        'ops:publication-reference': [
          {
            'document-id': [
              {
                '@document-id-type': 'docdb',
                country: { $: 'WO' },
                'doc-number': { $: '2016022939' },
                kind: { $: 'A1' },
                date: { $: '20160211' },
              },
            ],
            'bibliographic-data': {
              'invention-title': { '@lang': 'en', $: 'Anti-CDCP1 antibodies' },
              parties: {
                applicants: { applicant: { 'applicant-name': { name: { $: 'ACME BIO INC' } } } },
              },
              'patent-classifications': {
                'patent-classification': { 'classification-symbol': { $: 'C07K 16/28' } },
              },
            },
          },
          {
            'document-id': {
              '@document-id-type': 'epodoc',
              country: { $: 'EP' },
              'doc-number': { $: '3456789' },
              kind: { $: 'A1' },
              date: { $: '20200115' },
            },
            'invention-title': [{ '@lang': 'de', $: 'Konjugat' }, { '@lang': 'en', $: 'Targeted conjugate' }],
          },
        ],
      },
    },
  },
};

describe('patentSearchTool', () => {
  it('returns an empty result without throwing when EPO credentials are missing', async () => {
    delete process.env.SONNY_EPO_KEY;
    delete process.env.SONNY_EPO_SECRET;
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new Error('fetch should not be called');
    }) as unknown as typeof fetch;

    await expect(patentSearchTool.call({ query: 'CDCP1' }, fetchImpl)).resolves.toEqual([]);
    expect(called).toBe(false);
  });

  it('normalizes OPS search hits to canonical patent evidence', async () => {
    process.env.SONNY_EPO_KEY = 'key';
    process.env.SONNY_EPO_SECRET = 'secret';
    process.env.SONNY_EPO_BASE = 'https://ops.example.test/3.2';
    const fetchImpl = (async (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes('/auth/accesstoken')) {
        return new Response(JSON.stringify({ access_token: 'token', expires_in: 1200 }), { status: 200 });
      }
      if (value.includes('/published-data/search/biblio')) {
        return new Response(JSON.stringify(SEARCH_RESULT), { status: 200 });
      }
      throw new Error(`unexpected URL ${value}`);
    }) as unknown as typeof fetch;

    const out = await patentSearchTool.call({ symbol: 'CDCP1' }, fetchImpl);

    expect(out).toHaveLength(2);
    expect(out.map((evidence) => evidence.kind)).toEqual(['patent', 'patent']);
    expect(out.map((evidence) => evidence.id)).toEqual([
      'PATENT:WO2016022939A1',
      'PATENT:EP3456789A1',
    ]);
    expect(out[0].url).toBe('https://worldwide.espacenet.com/patent/search?q=pn%3DWO2016022939');
    expect(out[1].url).toBe('https://worldwide.espacenet.com/patent/search?q=pn%3DEP3456789');
    expect(out[0].snippet).toContain('ACME BIO INC');
    expect(out[0].snippet).toContain('2016-02-11');
  });

  it('returns an empty result without throwing on a non-OK search response', async () => {
    process.env.SONNY_EPO_KEY = 'key';
    process.env.SONNY_EPO_SECRET = 'secret';
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).includes('/auth/accesstoken')) {
        return new Response(JSON.stringify({ access_token: 'token', expires_in: 1200 }), { status: 200 });
      }
      return new Response('', { status: 503 });
    }) as unknown as typeof fetch;

    await expect(patentSearchTool.call({ target: 'CDCP1' }, fetchImpl)).resolves.toEqual([]);
  });
});
