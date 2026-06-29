import type { Claim, Section, TraceEvent } from '@sonny/shared';
import type { Tool } from '@sonny/mcp-gateway';
import { EvidenceStore } from './evidenceStore.js';
import type { StructuredModel } from './model.js';
import type { ThreadBrief, ResearchBudget } from './researcher.js';
import { produceResearchSection } from './produceResearchSection.js';
import { seedStructuredEvidence } from './leadSeed.js';

export interface DeepResearchResult {
  target: string;
  sections: Section[];
  weighing: { takeaway: string; claims: Claim[] };
}

export async function runDeepResearch(opts: {
  target: string; roster: ThreadBrief[];
  literatureTools: Tool[]; structuredTools: Tool[];
  specialistModel: StructuredModel; verifierModel: StructuredModel; leadModel: StructuredModel;
  emit: (e: TraceEvent) => void; budget: ResearchBudget;
}): Promise<DeepResearchResult> {
  const { target, roster, literatureTools, structuredTools, specialistModel, verifierModel, emit, budget } = opts;
  const store = new EvidenceStore();

  await seedStructuredEvidence({ target, tools: structuredTools, store, emit });

  emit({ type: 'lead_decompose', specialists: roster.map((b) => b.id) });
  const sections = await Promise.all(roster.map((brief) =>
    produceResearchSection({ brief, target, tools: literatureTools, store, specialistModel, verifierModel, emit, budget }),
  ));

  return { target, sections, weighing: { takeaway: '', claims: [] } };
}
