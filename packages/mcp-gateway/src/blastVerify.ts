import type { Evidence } from '@sonny/shared';
import { XMLParser } from 'fast-xml-parser';
import type { Tool } from './tool.js';

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

const ENDPOINT = 'https://blast.ncbi.nlm.nih.gov/Blast.cgi';
const EMAIL = process.env.SONNY_NCBI_EMAIL ?? 'sonny-agent@example.com';
const parser = new XMLParser({ ignoreAttributes: true, textNodeName: '#text', parseTagValue: false });

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

      const snippet = organism
        ? `${percentIdentity}% id, E=${eValue}, ${organism}`
        : `${percentIdentity}% id, E=${eValue}`;

      return {
        id: `BLAST:${accession}`,
        kind: isPatentDb ? 'patent' : 'dataset',
        source: `NCBI BLAST ${program} (${database})`,
        title: def,
        snippet,
        passage: `Aligned ${alignLen} residues, query coverage ${queryCoverage}%.`,
        url: `https://www.ncbi.nlm.nih.gov/${accPath}/${accession}`,
        raw: { accession, percentIdentity, eValue, bitScore, queryCoverage, organism, database, program },
        retrievedAt: now,
      };
    });
  },
};
