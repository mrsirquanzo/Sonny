// Live eval runner (opt-in): runs the orchestrator on each golden case and prints metrics.
// Usage: ANTHROPIC_API_KEY=... pnpm --filter @sonny/eval exec tsx src/index.ts
import { readFileSync } from 'node:fs';
import { runOrchestration, AnthropicModel } from '@mrsirquanzo/sonny-core';
import { openTargetsTool, pubmedTool } from '@mrsirquanzo/sonny-mcp-gateway';
import type { TraceEvent } from '@mrsirquanzo/sonny-shared';
import { recallAtK, faithfulness } from './score.js';

const gold = JSON.parse(readFileSync(new URL('../golden/egfr.json', import.meta.url), 'utf8')) as
  { query: string; symbol: string; expectedEvidenceIds: string[] };

const retrieved: string[] = [];
const out = await runOrchestration({
  query: gold.query, symbol: gold.symbol, tools: [openTargetsTool, pubmedTool],
  specialistModel: new AnthropicModel(), verifierModel: new AnthropicModel(),
  emit: (e: TraceEvent) => { if (e.type === 'evidence_registered') retrieved.push(e.id); },
});
console.log('recall@k :', recallAtK(retrieved, gold.expectedEvidenceIds));
console.log('faithfulness :', faithfulness(out.shipped, out.verdicts));
