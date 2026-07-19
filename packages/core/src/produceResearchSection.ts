import type { Claim, Section, TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import type { EvidenceStore } from './evidenceStore.js';
import type { StructuredModel } from './model.js';
import { groundClaims } from './grounding.js';
import { verifyClaims } from './verifier.js';
import { computeRag, createSourceIdentityResolver } from './rag.js';
import { runResearcher, type ThreadBrief, type ResearchBudget, type ResearchContext } from './researcher.js';

export async function produceResearchSection(opts: {
  brief: ThreadBrief; target: string; tools: Tool[]; store: EvidenceStore;
  specialistModel: StructuredModel; verifierModel: StructuredModel;
  emit: (e: TraceEvent) => void; budget: ResearchBudget;
  context?: ResearchContext;
}): Promise<Section> {
  const { brief, target, tools, store, specialistModel, verifierModel, emit, budget, context } = opts;
  const findings = await runResearcher({ brief, target, tools, store, model: specialistModel, verifierModel, emit, budget, context });

  const { shippable } = groundClaims(findings.claims, store);
  const verdicts = await verifyClaims(shippable, store, verifierModel);
  for (const v of verdicts) emit({ type: 'verdict', verdict: v });

  const supported: Claim[] = shippable.filter((c) => verdicts.find((v) => v.claimId === c.id)?.status === 'supported');
  const sources = [...new Set(supported.flatMap((c) => c.citations))];
  const section: Section = {
    kind: 'research', id: brief.id, title: brief.title, takeaway: findings.takeaway,
    claims: supported, sources, rag: computeRag(shippable, verdicts, createSourceIdentityResolver(store.all())),
    critiques: findings.critiques,
  };
  emit({ type: 'section_complete', section });
  return section;
}
