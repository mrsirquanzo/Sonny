import type { Claim, Section, TraceEvent } from '@sonny/shared';
import type { Tool } from '@sonny/mcp-gateway';
import { EvidenceStore } from './evidenceStore.js';
import type { StructuredModel } from './model.js';
import type { ThreadBrief, ResearchBudget } from './researcher.js';
import { produceResearchSection } from './produceResearchSection.js';
import { seedStructuredEvidence } from './leadSeed.js';
import { assessCompleteness, fillGap, mergeGapClaims } from './completeness.js';

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

  const { complete, gaps } = await assessCompleteness(sections, opts.leadModel);
  emit({ type: 'completeness_verdict', complete, gaps: gaps.map((g) => g.question) });
  let finalSections = sections;
  if (!complete) {
    for (const gap of gaps) {
      const idx = finalSections.findIndex((s) => s.id === gap.specialistId);
      if (idx === -1) continue;
      const claims = await fillGap({ gap, tools: literatureTools, store, specialistModel, verifierModel, emit });
      finalSections = finalSections.map((s, i) => (i === idx ? mergeGapClaims(s, claims) : s));
    }
  }

  return { target, sections: finalSections, weighing: { takeaway: '', claims: [] } };
}
