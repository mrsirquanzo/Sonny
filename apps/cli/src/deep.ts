import { AnthropicModel, runDeepResearch, RESEARCH_ROSTER } from '@sonny/core';
import { europePmcSearchTool, pmcFullTextTool, openTargetsTargetTool, clinicalTrialsTool } from '@sonny/mcp-gateway';
import { formatTrace } from './run.js';

export async function runDeep(target: string): Promise<void> {
  const t = target.trim() || 'CDCP1';
  const result = await runDeepResearch({
    target: t, roster: RESEARCH_ROSTER,
    literatureTools: [europePmcSearchTool, pmcFullTextTool],
    structuredTools: [openTargetsTargetTool, clinicalTrialsTool],
    specialistModel: new AnthropicModel(), verifierModel: new AnthropicModel(), leadModel: new AnthropicModel(),
    emit: (e) => process.stdout.write(formatTrace([e]) + '\n'),
    budget: { maxRounds: 4 },
  });

  for (const s of result.sections) {
    process.stdout.write(`\n[${s.rag.toUpperCase()}] ${s.title}\n  ${s.takeaway}\n`);
    for (const c of s.claims) {
      process.stdout.write(`  - ${c.text} ${c.citations.map((id) => `[${id}]`).join(' ')}\n`);
    }
  }
  if (result.weighing.claims.length) {
    process.stdout.write(`\nCROSS-THREAD WEIGHING\n  ${result.weighing.takeaway}\n`);
    for (const c of result.weighing.claims) {
      process.stdout.write(`  - ${c.text} ${c.citations.map((id) => `[${id}]`).join(' ')}\n`);
    }
  }
}
