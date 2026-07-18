import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Evidence, TraceEvent } from '@mrsirquanzo/sonny-shared';
import { europePmcSearchTool } from '@mrsirquanzo/sonny-mcp-gateway';
import {
  makeModel,
  OllamaEmbeddings,
  retrieveResearchHits,
  type StructuredModel,
} from '@mrsirquanzo/sonny-core';
import { retrievalRecall, type RunArtifacts } from './metrics.js';
import { loadGolden } from './runner.js';
import type { GoldenTarget } from './goldenSet.js';

const TOP_K = Number(process.env.SONNY_RETRIEVAL_TOP_K ?? 8);
const OUTPUT = process.env.SONNY_HYBRID_EVAL_OUT ?? 'results/hybrid-retrieval-recall.md';

interface Row {
  target: string;
  expected: number;
  baseline: number;
  hybrid: number;
  lift: number;
  baselineFound: string[];
  hybridFound: string[];
}

function artifacts(evidence: Evidence[]): RunArtifacts {
  return {
    briefing: { verdict: 'insufficient-evidence', sections: [] },
    evidenceById: new Map(evidence.map((item) => [item.id, item])),
    elapsedMs: 0,
  };
}

function goldenQuestions(golden: GoldenTarget): string[] {
  const probes = golden.claimProbes.map((probe) => probe.statement.trim()).filter(Boolean);
  return probes.length ? probes : [`What is the published evidence for ${golden.target}?`];
}

async function retrieveTarget(opts: {
  golden: GoldenTarget;
  hybrid: boolean;
  model: StructuredModel;
  embeddings: OllamaEmbeddings;
  events: TraceEvent[];
}): Promise<Evidence[]> {
  const byId = new Map<string, Evidence>();
  for (const question of goldenQuestions(opts.golden)) {
    const hits = await retrieveResearchHits({
      specialist: 'retrieval_eval',
      target: opts.golden.target,
      question,
      // The golden format has questions/probes but no planner concepts. A broad
      // target-only query is therefore the reproducible lexical control.
      concept: '',
      terms: [opts.golden.target.toLowerCase()],
      search: europePmcSearchTool,
      model: opts.model,
      embeddings: opts.embeddings,
      hybrid: opts.hybrid,
      topK: TOP_K,
      emit: (event) => opts.events.push(event),
    });
    for (const hit of hits) byId.set(hit.id, hit);
  }
  return [...byId.values()];
}

function detailFound(detail: unknown): string[] {
  if (!detail || typeof detail !== 'object') return [];
  const found = (detail as { found?: unknown }).found;
  return Array.isArray(found) ? found.filter((item): item is string => typeof item === 'string') : [];
}

function percent(value: number): string { return `${(value * 100).toFixed(1)}%`; }

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

async function writeOutput(markdown: string): Promise<void> {
  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, markdown, 'utf8');
}

async function writeBlocked(error: unknown, model: string): Promise<void> {
  let pendingRows = '| (golden set unavailable) | — | not measured | not measured | — |';
  try {
    const golden = await loadGolden('full');
    pendingRows = golden.map((target) =>
      `| ${target.target} | ${target.seminalPmids.length} | not measured | not measured | — |`,
    ).join('\n');
  } catch {
    // Preserve the original live-service failure as the actionable error.
  }
  const markdown = `# Hybrid retrieval recall evaluation\n\n` +
    `Status: **pending — live services unavailable**\n\n` +
    `- Attempted: ${new Date().toISOString()}\n` +
    `- Embedding model: \`${model}\`\n` +
    `- Recall cutoff: ${TOP_K} per golden question\n` +
    `- Error: \`${String(error).replace(/`/g, "'")}\`\n\n` +
    `| Target | Gold PMIDs | Baseline recall@${TOP_K} | Hybrid recall@${TOP_K} | Lift |\n` +
    `|---|---:|---:|---:|---:|\n${pendingRows}\n\n` +
    `No recall values are reported because treating blocked live I/O as empty retrieval would fabricate a measurement.\n`;
  await writeOutput(markdown);
  console.error(markdown);
}

export async function runHybridRetrievalRecall(): Promise<Row[]> {
  const embeddings = new OllamaEmbeddings();
  // Fail closed before evaluating: safeToolCall intentionally converts search
  // failures to [], which is correct in production but invalid for measurement.
  await embeddings.embed(['Sonny live embedding preflight']);
  await europePmcSearchTool.call({ query: 'EXT_ID:23208492 AND SRC:MED', pageSize: 1 });

  const model = makeModel();
  const golden = await loadGolden('full');
  const rows: Row[] = [];

  for (const target of golden) {
    const baselineEvents: TraceEvent[] = [];
    const hybridEvents: TraceEvent[] = [];
    const baselineEvidence = await retrieveTarget({ golden: target, hybrid: false, model, embeddings, events: baselineEvents });
    const hybridEvidence = await retrieveTarget({ golden: target, hybrid: true, model, embeddings, events: hybridEvents });

    if (hybridEvidence.length >= 2 && !hybridEvents.some((event) => event.type === 'dense_score')) {
      throw new Error(`${target.target}: hybrid candidates were not scored by Ollama embeddings`);
    }
    if (target.seminalPmids.length > 0 && !hybridEvents.some((event) => event.type === 'query_rewrite' && event.variants.length > 1)) {
      throw new Error(`${target.target}: query rewriting produced no additional variants`);
    }

    const baseline = retrievalRecall(artifacts(baselineEvidence), target);
    const hybrid = retrievalRecall(artifacts(hybridEvidence), target);
    rows.push({
      target: target.target,
      expected: target.seminalPmids.length,
      baseline: baseline.score,
      hybrid: hybrid.score,
      lift: hybrid.score - baseline.score,
      baselineFound: detailFound(baseline.detail),
      hybridFound: detailFound(hybrid.detail),
    });
  }

  const evaluated = rows.filter((row) => row.expected > 0);
  const allBaseline = mean(rows.map((row) => row.baseline));
  const allHybrid = mean(rows.map((row) => row.hybrid));
  const evidenceBaseline = mean(evaluated.map((row) => row.baseline));
  const evidenceHybrid = mean(evaluated.map((row) => row.hybrid));
  const table = rows.map((row) =>
    `| ${row.target} | ${row.expected} | ${percent(row.baseline)} | ${percent(row.hybrid)} | ${(row.lift * 100).toFixed(1)} pp | ${row.baselineFound.join(', ') || '—'} | ${row.hybridFound.join(', ') || '—'} |`,
  ).join('\n');
  const markdown = `# Hybrid retrieval recall evaluation\n\n` +
    `Status: **measured live**\n\n` +
    `- Measured: ${new Date().toISOString()}\n` +
    `- Embedding model: \`${embeddings.model}\` via \`${embeddings.endpoint}\`\n` +
    `- Recall cutoff: ${TOP_K} per golden question\n` +
    `- Protocol: each golden claim probe is a question; baseline uses the target-only Europe PMC query; hybrid adds LLM variants, unions candidates, embeds title+abstract with Ollama, and applies RRF.\n\n` +
    `| Target | Gold PMIDs | Baseline recall@${TOP_K} | Hybrid recall@${TOP_K} | Lift | Baseline found | Hybrid found |\n` +
    `|---|---:|---:|---:|---:|---|---|\n${table}\n` +
    `| **Mean (all targets)** |  | **${percent(allBaseline)}** | **${percent(allHybrid)}** | **${((allHybrid - allBaseline) * 100).toFixed(1)} pp** |  |  |\n` +
    `| **Mean (targets with gold PMIDs)** |  | **${percent(evidenceBaseline)}** | **${percent(evidenceHybrid)}** | **${((evidenceHybrid - evidenceBaseline) * 100).toFixed(1)} pp** |  |  |\n\n` +
    `Targets with no seminal PMIDs score 100% by the existing \`retrievalRecall\` definition, so the gold-bearing-target mean is also shown.\n`;
  await writeOutput(markdown);
  console.log(markdown);
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const model = process.env.SONNY_EMBED_MODEL ?? 'nomic-embed-text';
  runHybridRetrievalRecall().catch(async (error) => {
    await writeBlocked(error, model);
    process.exitCode = 1;
  });
}
