import { AnthropicModel, produceResearchSection, EvidenceStore } from '@sonny/core';
import { europePmcSearchTool, pmcFullTextTool } from '@sonny/mcp-gateway';
import { formatTrace } from './run.js';

export async function runDeep(target: string): Promise<void> {
  const t = target.trim() || 'CDCP1';
  const section = await produceResearchSection({
    brief: { id: 'target_biology', title: 'Target Biology',
      objective: `Assess the biology and mechanism of ${t} at expert depth.`,
      promptHint: 'Characterize the target: structure, mechanism of action, pathway, and expression.' },
    target: t, tools: [europePmcSearchTool, pmcFullTextTool],
    store: new EvidenceStore(),
    specialistModel: new AnthropicModel(), verifierModel: new AnthropicModel(),
    emit: (e) => process.stdout.write(formatTrace([e]) + '\n'),
    budget: { maxRounds: 4 },
  });
  process.stdout.write(`\n[${section.rag.toUpperCase()}] ${section.title}\n  ${section.takeaway}\n`);
}
