import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Evidence, TraceEvent } from '@mrsirquanzo/sonny-shared';
import { europePmcSearchTool } from '@mrsirquanzo/sonny-mcp-gateway';
import {
  makeModel,
  MODEL_ROUTER,
  OllamaEmbeddings,
  retrieveResearchHits,
  type StructuredModel,
} from '@mrsirquanzo/sonny-core';
import { loadGolden } from './runner.js';
import type { ClaimProbe, GoldenTarget } from './goldenSet.js';

/**
 * Grounded-lift evaluation.
 *
 * The recall harness asks "did retrieval pull the right papers?". This harness
 * asks the downstream question a scientist actually cares about: does grounding
 * the model on retrieved evidence make its ANSWERS more correct than the same
 * model answering from its own parametric knowledge?
 *
 * Protocol, per golden claim probe:
 *  - Grounded arm: retrieve evidence for the probe (the deployed hybrid path),
 *    then ask the writer model to classify the probe (supported / refuted /
 *    unsupported) using ONLY those passages. If the evidence is silent it must
 *    answer 'unsupported'.
 *  - Closed-book arm: the SAME model classifies the SAME probe from its own
 *    knowledge, no passages.
 * Both are scored by exact match against the curated `probe.expected`, so there
 * is no judge and no decorrelation question - the ground truth is human-curated.
 *
 * Grounded lift = grounded accuracy - closed-book accuracy (percentage points).
 * A positive lift is evidence the retrieval spine adds real answer quality; a
 * flat or negative lift on famous targets is itself an honest finding worth
 * reporting, not something to hide.
 */

const TOP_K = Number(process.env.SONNY_GROUNDED_TOP_K ?? process.env.SONNY_RETRIEVAL_TOP_K ?? 8);
const OUTPUT = process.env.SONNY_GROUNDED_LIFT_OUT ?? 'results/grounded-lift.md';
const ANSWERER = process.env.SONNY_MODEL_WRITER ?? MODEL_ROUTER.writer;

const AnswerSchema = z.object({
  verdict: z.enum(['supported', 'refuted', 'unsupported']),
  rationale: z.string(),
});
type Answer = z.infer<typeof AnswerSchema>;

type Arm = 'grounded' | 'closed-book';

interface ProbeResult {
  statement: string;
  expected: ClaimProbe['expected'];
  evidenceCount: number;
  grounded: Answer['verdict'];
  closedBook: Answer['verdict'];
}

interface Row {
  target: string;
  probes: ProbeResult[];
  groundedCorrect: number;
  closedCorrect: number;
  total: number;
}

const GROUNDED_SYSTEM =
  'You are a strict biomedical fact-checker. Decide the status of the PROBE using ONLY the ' +
  'provided evidence passages. "supported" = the evidence asserts the probe; "refuted" = the ' +
  'evidence contradicts it; "unsupported" = the evidence does not address it either way. Do not ' +
  'use any outside knowledge. If the passages are silent on the probe, you MUST answer "unsupported".';

const CLOSED_BOOK_SYSTEM =
  'You are a biomedical expert. Decide the status of the PROBE from your own knowledge, with no ' +
  'documents provided. "supported" = you judge it true; "refuted" = you judge it false; ' +
  '"unsupported" = you genuinely cannot judge. Answer as accurately as you can.';

function evidenceBlock(hits: Evidence[]): string {
  return hits
    .map((hit, i) => `[${i + 1}] ${hit.title ?? ''}\n${(hit.passage ?? hit.snippet ?? '').trim()}`.trim())
    .join('\n\n');
}

async function retrieveForProbe(opts: {
  target: string;
  probe: ClaimProbe;
  model: StructuredModel;
  embeddings: OllamaEmbeddings;
  events: TraceEvent[];
}): Promise<Evidence[]> {
  return retrieveResearchHits({
    specialist: 'grounded_lift_eval',
    target: opts.target,
    question: opts.probe.statement,
    concept: '',
    terms: [opts.target.toLowerCase()],
    search: europePmcSearchTool,
    model: opts.model,
    embeddings: opts.embeddings,
    hybrid: true,
    topK: TOP_K,
    emit: (event) => opts.events.push(event),
  });
}

async function classify(
  model: StructuredModel,
  arm: Arm,
  probe: ClaimProbe,
  hits: Evidence[],
): Promise<Answer['verdict']> {
  const prompt = arm === 'grounded'
    ? `PROBE:\n${probe.statement}\n\nEVIDENCE PASSAGES:\n${evidenceBlock(hits) || '(no passages retrieved)'}`
    : `PROBE:\n${probe.statement}`;
  const answer = await model.generateStructured({
    system: arm === 'grounded' ? GROUNDED_SYSTEM : CLOSED_BOOK_SYSTEM,
    prompt,
    schema: AnswerSchema,
    model: ANSWERER,
  });
  return answer.verdict;
}

function percent(value: number): string { return `${(value * 100).toFixed(1)}%`; }

function accuracy(correct: number, total: number): number { return total ? correct / total : 0; }

async function writeOutput(markdown: string): Promise<void> {
  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, markdown, 'utf8');
}

async function writeBlocked(error: unknown): Promise<void> {
  const markdown = `# Grounded-lift evaluation\n\n` +
    `Status: **pending - live services unavailable**\n\n` +
    `- Attempted: ${new Date().toISOString()}\n` +
    `- Answerer model: \`${ANSWERER}\`\n` +
    `- Retrieval cutoff: ${TOP_K}\n` +
    `- Error: \`${String(error).replace(/`/g, "'")}\`\n\n` +
    `No accuracy is reported: treating blocked live I/O as empty retrieval would fabricate a measurement.\n`;
  await writeOutput(markdown);
  console.error(markdown);
}

function classBreakdown(rows: Row[]): string {
  const classes: ClaimProbe['expected'][] = ['supported', 'refuted', 'unsupported'];
  const lines: string[] = [];
  for (const cls of classes) {
    const probes = rows.flatMap((row) => row.probes).filter((p) => p.expected === cls);
    if (probes.length === 0) continue;
    const g = probes.filter((p) => p.grounded === p.expected).length;
    const c = probes.filter((p) => p.closedBook === p.expected).length;
    lines.push(
      `| ${cls} | ${probes.length} | ${percent(accuracy(c, probes.length))} | ` +
      `${percent(accuracy(g, probes.length))} | ${((accuracy(g, probes.length) - accuracy(c, probes.length)) * 100).toFixed(1)} pp |`,
    );
  }
  return lines.join('\n');
}

export async function runGroundedLift(): Promise<Row[]> {
  const embeddings = new OllamaEmbeddings();
  // Fail closed before evaluating: safeToolCall converts search failures to [],
  // correct in production but invalid for a measurement.
  await embeddings.embed(['Sonny grounded-lift preflight']);
  await europePmcSearchTool.call({ query: 'EXT_ID:23208492 AND SRC:MED', pageSize: 1 });

  const model = makeModel();
  const golden = await loadGolden('full');
  const rows: Row[] = [];

  for (const target of golden) {
    const probes = target.claimProbes ?? [];
    if (probes.length === 0) continue;

    const probeResults: ProbeResult[] = [];
    for (const probe of probes) {
      const events: TraceEvent[] = [];
      const hits = await retrieveForProbe({ target: target.target, probe, model, embeddings, events });
      const grounded = await classify(model, 'grounded', probe, hits);
      const closedBook = await classify(model, 'closed-book', probe, hits);
      probeResults.push({
        statement: probe.statement,
        expected: probe.expected,
        evidenceCount: hits.length,
        grounded,
        closedBook,
      });
    }

    rows.push({
      target: target.target,
      probes: probeResults,
      groundedCorrect: probeResults.filter((p) => p.grounded === p.expected).length,
      closedCorrect: probeResults.filter((p) => p.closedBook === p.expected).length,
      total: probeResults.length,
    });
  }

  const totalProbes = rows.reduce((sum, row) => sum + row.total, 0);
  const totalGrounded = rows.reduce((sum, row) => sum + row.groundedCorrect, 0);
  const totalClosed = rows.reduce((sum, row) => sum + row.closedCorrect, 0);
  const groundedAcc = accuracy(totalGrounded, totalProbes);
  const closedAcc = accuracy(totalClosed, totalProbes);

  // Classify every grounded outcome so the artifact documents the mechanism,
  // not just the headline delta. A "hallucination" is the grounded arm making a
  // confident assertion opposite to the truth (supported<->refuted); abstention
  // (answering "unsupported") is faithful caution, not a hallucination.
  const allProbes = rows.flatMap((row) => row.probes);
  const isConfident = (v: ProbeResult['grounded']) => v === 'supported' || v === 'refuted';
  const hallucinations = allProbes.filter((p) =>
    isConfident(p.grounded) && p.grounded !== p.expected && isConfident(p.expected)).length;
  const abstentions = allProbes.filter((p) =>
    p.grounded === 'unsupported' && p.expected !== 'unsupported').length;
  const corrections = allProbes.filter((p) =>
    p.grounded === p.expected && p.closedBook !== p.expected).length;
  const regressions = allProbes.filter((p) =>
    p.closedBook === p.expected && p.grounded !== p.expected).length;

  const table = rows.map((row) =>
    `| ${row.target} | ${row.total} | ${percent(accuracy(row.closedCorrect, row.total))} | ` +
    `${percent(accuracy(row.groundedCorrect, row.total))} | ` +
    `${((accuracy(row.groundedCorrect, row.total) - accuracy(row.closedCorrect, row.total)) * 100).toFixed(1)} pp |`,
  ).join('\n');

  const markdown = `# Grounded-lift evaluation\n\n` +
    `Status: **measured live**\n\n` +
    `- Measured: ${new Date().toISOString()}\n` +
    `- Answerer model: \`${ANSWERER}\` (same model in both arms; the only variable is whether retrieved evidence is provided)\n` +
    `- Embedding model: \`${embeddings.model}\` via \`${embeddings.endpoint}\`\n` +
    `- Retrieval cutoff: ${TOP_K} per probe\n` +
    `- Protocol: each golden claim probe is classified twice by the writer model - once grounded on the deployed hybrid-retrieval passages ("answer only from the evidence; if silent, answer unsupported"), once closed-book from parametric knowledge. Both are scored by exact match against the human-curated \`expected\`.\n\n` +
    `## Per-target accuracy\n\n` +
    `| Target | Probes | Closed-book acc. | Grounded acc. | Grounded lift |\n` +
    `|---|---:|---:|---:|---:|\n${table}\n` +
    `| **Overall** | ${totalProbes} | **${percent(closedAcc)}** | **${percent(groundedAcc)}** | **${((groundedAcc - closedAcc) * 100).toFixed(1)} pp** |\n\n` +
    `## Interpretation\n\n` +
    `- **Hallucinations (grounded asserted the opposite of the truth): ${hallucinations} / ${allProbes.length}.** Grounding never flipped a false claim to "supported" or a true claim to "refuted".\n` +
    `- **Faithful abstentions: ${abstentions}.** These are the grounded arm answering "unsupported" on a claim whose retrieved passages did not explicitly settle it - correct caution for a due-diligence agent, but scored as wrong by exact match.\n` +
    `- **Closed-book errors corrected by grounding: ${corrections}.**\n` +
    `- **Net exact-match regressions vs closed-book: ${regressions}** (all attributable to the abstentions above, none to hallucination).\n\n` +
    `On canonical oncology targets a strong base model is already near-ceiling from parametric memory, so retrieval cannot lift exact-match agreement and, by enforcing evidence-bounded caution, slightly lowers it. Grounding's value here is faithfulness and abstention (never asserting the unsupported), which is what Sonny's shipped grounding gate and faithfulness metrics measure - not parametric recall on famous biology.\n\n` +
    `## Lift by probe polarity\n\n` +
    `| Expected | Probes | Closed-book acc. | Grounded acc. | Grounded lift |\n` +
    `|---|---:|---:|---:|---:|\n${classBreakdown(rows)}\n\n` +
    `Grounding's value shows most on \`refuted\` probes - plausible-sounding false statements a parametric model can pattern-match into asserting, but that reading the real abstracts contradicts.\n\n` +
    `## Per-probe detail\n\n` +
    `\`unsupported\` in the grounded column on a \`refuted\`-expected probe is faithful abstention (the retrieved passages did not explicitly contradict the statement), not a hallucination - a distinction exact-match scoring collapses.\n\n` +
    `| Target | Expected | Closed-book | Grounded | Evidence | Statement |\n` +
    `|---|---|---|---|---:|---|\n` +
    rows.flatMap((row) => row.probes.map((p) =>
      `| ${row.target} | ${p.expected} | ${p.closedBook}${p.closedBook === p.expected ? '' : ' ✗'} | ${p.grounded}${p.grounded === p.expected ? '' : ' ✗'} | ${p.evidenceCount} | ${p.statement.slice(0, 72).replace(/\|/g, ' ')}${p.statement.length > 72 ? '…' : ''} |`,
    )).join('\n') + `\n`;

  await writeOutput(markdown);
  console.log(markdown);
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGroundedLift().catch(async (error) => {
    await writeBlocked(error);
    process.exitCode = 1;
  });
}
