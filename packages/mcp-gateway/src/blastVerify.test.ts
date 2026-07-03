import { describe, it, expect } from 'vitest';
import { normalizeSequence, detectProgram, blastVerifyTool } from './blastVerify.js';

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
    const raw = e.raw as { percentIdentity: number; eValue: string; organism: string; queryCoverage: number; database: string; program: string; identity: number; alignLen: number };
    expect(raw.percentIdentity).toBe(100);
    expect(raw.queryCoverage).toBe(100);
    expect(raw.eValue).toBe('1e-80');
    expect(raw.organism).toBe('Homo sapiens');
    expect(raw.program).toBe('blastp');
    expect(raw.identity).toBe(120);
    expect(raw.alignLen).toBe(120);
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

  it('returns maxHits results when the XML has more hits, preserving order', async () => {
    const threeHitXml = `<?xml version="1.0"?>
<BlastOutput>
  <BlastOutput_query-len>120</BlastOutput_query-len>
  <BlastOutput_iterations>
    <Iteration>
      <Iteration_hits>
        <Hit>
          <Hit_def>hit one [Homo sapiens]</Hit_def>
          <Hit_accession>ACC1</Hit_accession>
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
        <Hit>
          <Hit_def>hit two [Mus musculus]</Hit_def>
          <Hit_accession>ACC2</Hit_accession>
          <Hit_len>110</Hit_len>
          <Hit_hsps>
            <Hsp>
              <Hsp_bit-score>200</Hsp_bit-score>
              <Hsp_evalue>1e-60</Hsp_evalue>
              <Hsp_query-from>1</Hsp_query-from>
              <Hsp_query-to>110</Hsp_query-to>
              <Hsp_identity>99</Hsp_identity>
              <Hsp_align-len>110</Hsp_align-len>
            </Hsp>
          </Hit_hsps>
        </Hit>
        <Hit>
          <Hit_def>hit three [Rattus norvegicus]</Hit_def>
          <Hit_accession>ACC3</Hit_accession>
          <Hit_len>100</Hit_len>
          <Hit_hsps>
            <Hsp>
              <Hsp_bit-score>180</Hsp_bit-score>
              <Hsp_evalue>1e-50</Hsp_evalue>
              <Hsp_query-from>1</Hsp_query-from>
              <Hsp_query-to>100</Hsp_query-to>
              <Hsp_identity>90</Hsp_identity>
              <Hsp_align-len>100</Hsp_align-len>
            </Hsp>
          </Hit_hsps>
        </Hit>
      </Iteration_hits>
    </Iteration>
  </BlastOutput_iterations>
</BlastOutput>`;
    const out = await blastVerifyTool.call(
      { sequence: 'EVQLVESGGGLVQPGGSLRL', maxHits: 2, pollIntervalMs: 0 },
      makeFetch(['READY'], { xml: threeHitXml }),
    );
    expect(out).toHaveLength(2);
    const raw0 = out[0].raw as { accession: string };
    const raw1 = out[1].raw as { accession: string };
    expect(raw0.accession).toBe('ACC1');
    expect(raw1.accession).toBe('ACC2');
  });

  it('produces no trailing comma in snippet when Hit_def has no organism bracket', async () => {
    const noOrganismXml = `<?xml version="1.0"?>
<BlastOutput>
  <BlastOutput_query-len>120</BlastOutput_query-len>
  <BlastOutput_iterations>
    <Iteration>
      <Iteration_hits>
        <Hit>
          <Hit_def>some antibody construct</Hit_def>
          <Hit_accession>PAT99999</Hit_accession>
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
    const out = await blastVerifyTool.call(
      { sequence: 'EVQLVESGGGLVQPGGSLRL', pollIntervalMs: 0 },
      makeFetch(['READY'], { xml: noOrganismXml }),
    );
    expect(out).toHaveLength(1);
    const e = out[0];
    expect(e.snippet).toBe('100% id, E=1e-80');
    const raw = e.raw as { organism: string };
    expect(raw.organism).toBe('');
  });
});

describe('blastVerifyTool short-query params', () => {
  function captureBodyFetch(bodyOut: { value: string }) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') { bodyOut.value = String(init.body); return new Response(SUBMIT, { status: 200 }); }
      if (String(url).includes('FORMAT_OBJECT=SearchInfo')) return new Response(statusBody('READY'), { status: 200 });
      return new Response(RESULT_XML, { status: 200 });
    }) as unknown as typeof fetch;
  }

  it('adds WORD_SIZE and MATRIX to the submit body when provided', async () => {
    const body = { value: '' };
    await blastVerifyTool.call({ sequence: 'EVQLVESGGG', wordSize: 2, matrix: 'PAM30', pollIntervalMs: 0 }, captureBodyFetch(body));
    expect(body.value).toContain('WORD_SIZE=2');
    expect(body.value).toContain('MATRIX=PAM30');
  });

  it('omits WORD_SIZE and MATRIX when not provided', async () => {
    const body = { value: '' };
    await blastVerifyTool.call({ sequence: 'EVQLVESGGG', pollIntervalMs: 0 }, captureBodyFetch(body));
    expect(body.value).not.toContain('WORD_SIZE');
    expect(body.value).not.toContain('MATRIX');
  });
});
