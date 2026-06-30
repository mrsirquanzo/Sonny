import type { Claim, Section, TraceEvent } from '@sonny/shared';
import type { Tool } from '@sonny/mcp-gateway';
import type { EvidenceStore } from './evidenceStore.js';
import type { StructuredModel } from './model.js';
import { groundClaims } from './grounding.js';
import { verifyClaims } from './verifier.js';
import { computeRag } from './rag.js';
import { runResearcher, type ThreadBrief, type ResearchBudget } from './researcher.js';

export async function produceResearchSection(opts: {
  brief: ThreadBrief; target: string; tools: Tool[]; store: EvidenceStore;
  specialistModel: StructuredModel; verifierModel: StructuredModel;
  emit: (e: TraceEvent) => void; budget: ResearchBudget;
}): Promise<Section> {
  const { brief, target, tools, store, specialistModel, verifierModel, emit, budget } = opts;
  const findings = await runResearcher({ brief, target, tools, store, model: specialistModel, verifierModel, emit, budget });

  const { shippable } = groundClaims(findings.claims, store);
  const verdicts = await verifyClaims(shippable, store, verifierModel);
  for (const v of verdicts) emit({ type: 'verdict', verdict: v });

  const supported: Claim[] = shippable.filter((c) => verdicts.find((v) => v.claimId === c.id)?.status === 'supported');
  const sources = [...new Set(supported.flatMap((c) => c.citations))];
  const section: Section = {
    id: brief.id, title: brief.title, takeaway: findings.takeaway,
    claims: supported, sources, rag: computeRag(shippable, verdicts),
    critiques: findings.critiques,
  };
  emit({ type: 'section_complete', section });
  return section;
}
