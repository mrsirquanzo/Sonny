# BLAST Verify Tool Implementation Plan (Patent Specialist - Slice 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `blast_verify` tool that submits a biological sequence to real NCBI BLAST and returns the ranked top hits as `Evidence[]`.

**Architecture:** A new tool in `packages/mcp-gateway` following the existing `Tool` contract (`call(args, fetchImpl?) => Promise<Evidence[]>`). Two pure helpers (`normalizeSequence`, `detectProgram`) are built and tested first; then the tool wraps NCBI BLAST's asynchronous submit -> poll -> fetch lifecycle, parses the XML result with `fast-xml-parser` (already used by `pmcFullText.ts`), and maps hits to `Evidence`. Timing knobs are optional args so unit tests run instantly with no live network.

**Tech Stack:** TypeScript ESM, Vitest, `fast-xml-parser`. Test runner: `pnpm --filter @sonny/mcp-gateway test`.

**Spec:** [docs/specs/2026-06-29-blast-verify-tool-design.md](../specs/2026-06-29-blast-verify-tool-design.md).

## Global Constraints

- Never use the em dash; use a plain hyphen.
- Never auto-add a commit co-author.
- ESM relative imports use the `.js` extension.
- Follow the existing `Tool` contract in `packages/mcp-gateway/src/tool.ts`; do not change it.
- Surgical: touch only `packages/mcp-gateway/src/blastVerify.ts`, `packages/mcp-gateway/src/blastVerify.test.ts`, and `packages/mcp-gateway/src/index.ts`.
- Output `kind` is `'patent'` for the patent database and `'dataset'` otherwise; both are already valid in `EvidenceKindSchema`.
- Tests inject `fetchImpl`; no live network in unit tests.

## File Structure

- Create: `packages/mcp-gateway/src/blastVerify.ts` - the `normalizeSequence` and `detectProgram` helpers and the `blastVerifyTool`.
- Create: `packages/mcp-gateway/src/blastVerify.test.ts` - unit tests.
- Modify: `packages/mcp-gateway/src/index.ts` - export the new tool.

---

### Task 1: Sequence helpers (`normalizeSequence`, `detectProgram`)

**Files:**
- Create: `packages/mcp-gateway/src/blastVerify.ts`
- Test: `packages/mcp-gateway/src/blastVerify.test.ts`

**Interfaces:**
- Produces: `normalizeSequence(input: string): string` - strips FASTA header lines (those starting with `>`), then removes every non-letter character and uppercases the rest.
- Produces: `detectProgram(seq: string): 'blastp' | 'blastn'` - returns `'blastn'` when `seq` is non-empty and contains only `A C G T U N`, else `'blastp'`.

- [ ] **Step 1: Write the failing tests**

Create `packages/mcp-gateway/src/blastVerify.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeSequence, detectProgram } from './blastVerify.js';

describe('normalizeSequence', () => {
  it('strips a FASTA header, whitespace, digits, and numbering and uppercases', () => {
    const input = '>seq1 anti-CDCP1 VH\n  1 evqlv esggg\n 11 lvqpg gslrl\n';
    expect(normalizeSequence(input)).toBe('EVQLVESGGGLVQPGGSLRL');
  });

  it('returns an empty string for header-only or blank input', () => {
    expect(normalizeSequence('>just a header')).toBe('');
    expect(normalizeSequence('   \n  ')).toBe('');
  });
});

describe('detectProgram', () => {
  it('returns blastn for a nucleotide-only sequence', () => {
    expect(detectProgram('ACGTACGTNNACGT')).toBe('blastn');
  });

  it('returns blastp for a sequence with non-nucleotide residues', () => {
    expect(detectProgram('EVQLVESGGGLVQPG')).toBe('blastp');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/mcp-gateway test -- blastVerify`
Expected: FAIL - `blastVerify.js` / the helpers do not exist yet.

- [ ] **Step 3: Implement the helpers**

Create `packages/mcp-gateway/src/blastVerify.ts`:

```ts
export function normalizeSequence(input: string): string {
  return input
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase();
}

export function detectProgram(seq: string): 'blastp' | 'blastn' {
  return /^[ACGTUN]+$/.test(seq) ? 'blastn' : 'blastp';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/mcp-gateway test -- blastVerify`
Expected: PASS - all four helper tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-gateway/src/blastVerify.ts packages/mcp-gateway/src/blastVerify.test.ts
git commit -m "feat(mcp-gateway): add sequence normalize and BLAST program detection helpers"
```

---

### Task 2: `blastVerifyTool` (async lifecycle + Evidence mapping + registry)

**Files:**
- Modify: `packages/mcp-gateway/src/blastVerify.ts` (add the tool below the helpers)
- Test: `packages/mcp-gateway/src/blastVerify.test.ts` (append)
- Modify: `packages/mcp-gateway/src/index.ts`

**Interfaces:**
- Consumes: `normalizeSequence`, `detectProgram` from Task 1; `Tool` from `./tool.js`; `Evidence` from `@sonny/shared`.
- Produces: `blastVerifyTool: Tool` with `name: 'blast_verify'`.
- Args consumed from the `call` argument object: `sequence` (string, required), `program` (`'auto' | 'blastp' | 'blastn'`, default `'auto'`), `database` (string, default `'nr'`), `expect` (number, default `10`), `maxHits` (number, default `10`), and the testing/timing knobs `pollIntervalMs` (default `15000`), `timeoutMs` (default `180000`), `initialDelayMs` (default `0`, which falls back to the RTOE the submit step reports).

- [ ] **Step 1: Write the failing tests**

Append to `packages/mcp-gateway/src/blastVerify.test.ts`:

```ts
import { blastVerifyTool } from './blastVerify.js';

const SUBMIT = '<html><!-- QBlastInfoBegin\n    RID = RID123\n    RTOE = 0\nQBlastInfoEnd --></html>';
const statusBody = (s: string) => `QBlastInfoBegin\n\tStatus=${s}\nQBlastInfoEnd\n`;
const RESULT_XML = `<?xml version="1.0"?>
<BlastOutput>
  <BlastOutput_program>blastp</BlastOutput_program>
  <BlastOutput_query-len>120</BlastOutput_query-len>
  <BlastOutput_iterations>
    <Iteration>
      <Iteration_hits>
        <Hit>
          <Hit_def>anti-CDCP1 antibody heavy chain [Homo sapiens]</Hit_def>
          <Hit_accession>ABC12345</Hit_accession>
          <Hit_len>120</Hit_len>
          <Hit_hsps>
            <Hsp>
              <Hsp_bit-score>240</Hsp_bit-score>
              <Hsp_evalue>1e-80</Hsp_evalue>
              <Hsp_query-from>1</Hsp_query-from>
              <Hsp_query-to>120</Hsp_query-to>
              <Hsp_identity>120</Hsp_identity>
              <Hsp_align-len>120</Hsp_align-len>
            </Hsp>
          </Hit_hsps>
        </Hit>
      </Iteration_hits>
    </Iteration>
  </BlastOutput_iterations>
</BlastOutput>`;

// Stateful fake fetch: POST = submit; GET SearchInfo = status; GET XML = result.
// `statuses` is consumed one per poll so we can model WAITING then READY.
function makeFetch(statuses: string[], opts: { xml?: string; submitOk?: boolean } = {}) {
  const queue = [...statuses];
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST') {
      return new Response(SUBMIT, { status: opts.submitOk === false ? 502 : 200 });
    }
    if (u.includes('FORMAT_OBJECT=SearchInfo')) {
      return new Response(statusBody(queue.shift() ?? 'READY'), { status: 200 });
    }
    if (u.includes('FORMAT_TYPE=XML')) {
      return new Response(opts.xml ?? RESULT_XML, { status: 200 });
    }
    throw new Error(`unexpected request: ${u}`);
  }) as unknown as typeof fetch;
}

describe('blastVerifyTool', () => {
  it('returns [] for an empty sequence without calling the network', async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response('', { status: 200 }); }) as unknown as typeof fetch;
    const out = await blastVerifyTool.call({ sequence: '   ' }, fetchImpl);
    expect(out).toHaveLength(0);
    expect(called).toBe(false);
  });

  it('submits via POST, polls until READY, and maps an XML hit to dataset Evidence', async () => {
    const out = await blastVerifyTool.call(
      { sequence: 'EVQLVESGGGLVQPGGSLRL', pollIntervalMs: 0 },
      makeFetch(['WAITING', 'READY']),
    );
    expect(out).toHaveLength(1);
    const e = out[0];
    expect(e.id).toBe('BLAST:ABC12345');
    expect(e.kind).toBe('dataset');
    expect(e.title).toBe('anti-CDCP1 antibody heavy chain [Homo sapiens]');
    const raw = e.raw as { percentIdentity: number; eValue: string; organism: string; queryCoverage: number; database: string; program: string };
    expect(raw.percentIdentity).toBe(100);
    expect(raw.queryCoverage).toBe(100);
    expect(raw.eValue).toBe('1e-80');
    expect(raw.organism).toBe('Homo sapiens');
    expect(raw.program).toBe('blastp');
    expect(e.snippet).toBe('100% id, E=1e-80, Homo sapiens');
  });

  it('maps hits from the patent database to kind patent', async () => {
    const out = await blastVerifyTool.call(
      { sequence: 'EVQLVESGGGLVQPGGSLRL', database: 'pataa', pollIntervalMs: 0 },
      makeFetch(['READY']),
    );
    expect(out[0].kind).toBe('patent');
  });

  it('throws when the search status is UNKNOWN', async () => {
    await expect(
      blastVerifyTool.call({ sequence: 'EVQLVESGGGLVQPGGSLRL', pollIntervalMs: 0 }, makeFetch(['UNKNOWN'])),
    ).rejects.toThrow(/UNKNOWN/);
  });

  it('throws when submission returns a non-OK status', async () => {
    await expect(
      blastVerifyTool.call({ sequence: 'EVQLVESGGGLVQPGGSLRL' }, makeFetch(['READY'], { submitOk: false })),
    ).rejects.toThrow(/HTTP 502/);
  });

  it('returns [] when the result has no hits', async () => {
    const emptyXml = '<?xml version="1.0"?><BlastOutput><BlastOutput_query-len>120</BlastOutput_query-len><BlastOutput_iterations><Iteration><Iteration_hits></Iteration_hits></Iteration></BlastOutput_iterations></BlastOutput>';
    const out = await blastVerifyTool.call(
      { sequence: 'EVQLVESGGGLVQPGGSLRL', pollIntervalMs: 0 },
      makeFetch(['READY'], { xml: emptyXml }),
    );
    expect(out).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sonny/mcp-gateway test -- blastVerify`
Expected: FAIL - `blastVerifyTool` is not exported yet.

- [ ] **Step 3: Implement the tool**

Append to `packages/mcp-gateway/src/blastVerify.ts`:

```ts
import type { Evidence } from '@sonny/shared';
import { XMLParser } from 'fast-xml-parser';
import type { Tool } from './tool.js';

const ENDPOINT = 'https://blast.ncbi.nlm.nih.gov/Blast.cgi';
const EMAIL = process.env.SONNY_NCBI_EMAIL ?? 'sonny-agent@example.com';
const parser = new XMLParser({ ignoreAttributes: true, textNodeName: '#text' });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function field(text: string, key: string): string | undefined {
  return text.match(new RegExp(`${key}\\s*=\\s*(\\S+)`))?.[1];
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export const blastVerifyTool: Tool = {
  name: 'blast_verify',
  description:
    'Verify a protein or nucleotide sequence against NCBI BLAST. Returns ranked top hits with percent identity, E-value, organism, and source database (including patent deposits). Use to confirm a sequence is real and correctly transcribed and to find what it matches.',
  async call(args, fetchImpl = fetch) {
    const sequence = normalizeSequence(String(args.sequence ?? ''));
    if (!sequence) return [];

    const requested = String(args.program ?? 'auto');
    const program = requested === 'blastp' || requested === 'blastn' ? requested : detectProgram(sequence);
    const database = String(args.database ?? 'nr');
    const expect = Number(args.expect ?? 10);
    const maxHits = Number(args.maxHits ?? 10);
    const pollIntervalMs = Number(args.pollIntervalMs ?? 15000);
    const timeoutMs = Number(args.timeoutMs ?? 180000);
    const initialDelayMs = Number(args.initialDelayMs ?? 0);

    // 1. Submit (POST so long antibody sequences are not capped by URL length).
    const body = new URLSearchParams({
      CMD: 'Put', PROGRAM: program, DATABASE: database, QUERY: sequence,
      EXPECT: String(expect), HITLIST_SIZE: String(maxHits), tool: 'sonny', email: EMAIL,
    });
    const submit = await fetchImpl(ENDPOINT, { method: 'POST', body });
    if (!submit.ok) throw new Error(`NCBI BLAST submit HTTP ${submit.status}`);
    const submitText = await submit.text();
    const rid = field(submitText, 'RID');
    if (!rid) throw new Error('NCBI BLAST: no RID returned from submit');
    const rtoe = Number(field(submitText, 'RTOE') ?? 0);

    // 2. Poll until READY.
    const deadline = Date.now() + timeoutMs;
    await sleep(initialDelayMs || Math.min(rtoe * 1000, timeoutMs));
    for (;;) {
      const poll = await fetchImpl(`${ENDPOINT}?CMD=Get&FORMAT_OBJECT=SearchInfo&RID=${encodeURIComponent(rid)}`);
      if (!poll.ok) throw new Error(`NCBI BLAST poll HTTP ${poll.status}`);
      const status = field(await poll.text(), 'Status');
      if (status === 'READY') break;
      if (status === 'UNKNOWN') throw new Error(`NCBI BLAST: search ${rid} failed (status UNKNOWN)`);
      if (Date.now() > deadline) throw new Error(`NCBI BLAST: timed out waiting for ${rid}`);
      await sleep(pollIntervalMs);
    }

    // 3. Fetch + parse the XML result.
    const result = await fetchImpl(`${ENDPOINT}?CMD=Get&FORMAT_TYPE=XML&RID=${encodeURIComponent(rid)}`);
    if (!result.ok) throw new Error(`NCBI BLAST fetch HTTP ${result.status}`);
    const parsed = parser.parse(await result.text()) as {
      BlastOutput?: { 'BlastOutput_query-len'?: number;
        BlastOutput_iterations?: { Iteration?: unknown } };
    };
    const root = parsed.BlastOutput;
    const queryLen = Number(root?.['BlastOutput_query-len'] ?? 0);
    const iteration = asArray(root?.BlastOutput_iterations?.Iteration)[0] as
      { Iteration_hits?: { Hit?: unknown } } | undefined;
    const hits = asArray(iteration?.Iteration_hits?.Hit) as Array<Record<string, unknown>>;
    if (hits.length === 0) return [];

    const now = new Date().toISOString();
    const isPatentDb = /pat/i.test(database);
    const accPath = program === 'blastn' ? 'nuccore' : 'protein';

    return hits.slice(0, maxHits).map<Evidence>((hit) => {
      const hsp = asArray((hit.Hit_hsps as { Hsp?: unknown } | undefined)?.Hsp)[0] as
        Record<string, unknown> | undefined;
      const alignLen = Number(hsp?.['Hsp_align-len'] ?? 0);
      const identity = Number(hsp?.['Hsp_identity'] ?? 0);
      const percentIdentity = alignLen ? round1((identity / alignLen) * 100) : 0;
      const qFrom = Number(hsp?.['Hsp_query-from'] ?? 0);
      const qTo = Number(hsp?.['Hsp_query-to'] ?? 0);
      const queryCoverage = queryLen ? round1(((qTo - qFrom + 1) / queryLen) * 100) : 0;
      const accession = String(hit.Hit_accession ?? '');
      const def = String(hit.Hit_def ?? '(no description)');
      const organism = def.match(/\[([^\]]+)\]/)?.[1] ?? '';
      const eValue = String(hsp?.['Hsp_evalue'] ?? '');
      const bitScore = Number(hsp?.['Hsp_bit-score'] ?? 0);

      return {
        id: `BLAST:${accession}`,
        kind: isPatentDb ? 'patent' : 'dataset',
        source: `NCBI BLAST ${program} (${database})`,
        title: def,
        snippet: `${percentIdentity}% id, E=${eValue}, ${organism}`.trim(),
        passage: `Aligned ${alignLen} residues, query coverage ${queryCoverage}%.`,
        url: `https://www.ncbi.nlm.nih.gov/${accPath}/${accession}`,
        raw: { accession, percentIdentity, eValue, bitScore, queryCoverage, organism, database, program },
        retrievedAt: now,
      };
    });
  },
};
```

Note: the `import` lines added here sit at the top of the file once written; if your editor places them mid-file, move all three `import` statements above the helper functions so the module parses.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sonny/mcp-gateway test -- blastVerify`
Expected: PASS - all helper and tool tests pass.

- [ ] **Step 5: Register the tool in the gateway index**

In `packages/mcp-gateway/src/index.ts`, add below the existing exports:

```ts
export { blastVerifyTool } from './blastVerify.js';
```

- [ ] **Step 6: Run the full gateway suite**

Run: `pnpm --filter @sonny/mcp-gateway test`
Expected: PASS - all gateway tests green, including the new file.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-gateway/src/blastVerify.ts packages/mcp-gateway/src/blastVerify.test.ts packages/mcp-gateway/src/index.ts
git commit -m "feat(mcp-gateway): add blast_verify tool for NCBI BLAST sequence verification"
```

---

## Notes for the controller

- After both tasks pass, a manual smoke validates the XML format choice against the live endpoint (not a unit test): submit a known antibody sequence with a tiny `pollIntervalMs` and confirm real hits map cleanly. If the live XML element names differ from the fixture, adjust the parser paths and the fixture together. The spec anticipates this format validation.
- Out of scope for this slice: the patent-sweep loop, identity verdict thresholds, ANARCI, EPO OPS, PDF ingest (slices 2-5).
