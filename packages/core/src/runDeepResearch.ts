import type { Claim, Evidence, Section, TraceEvent } from '@sonny/shared';
import type { Tool } from '@sonny/mcp-gateway';
import { EvidenceStore } from './evidenceStore.js';
import type { StructuredModel } from './model.js';
import type { ThreadBrief, ResearchBudget } from './researcher.js';
import { produceResearchSection } from './produceResearchSection.js';
import { seedStructuredEvidence } from './leadSeed.js';
import { orientWithReview } from './orientation.js';
import { assessCompleteness, fillGap, mergeGapClaims, type ResearchGap } from './completeness.js';
import { weighAcrossThreads } from './weighing.js';
import { assessDevelopability } from './critique/developability.js';

export interface DeepResearchResult {
  target: string;
  sections: Section[];
  weighing: { takeaway: string; claims: Claim[] };
  evidence: Evidence[];
}

function placeholderSection(brief: ThreadBrief, reason: string): Section {
  return { id: brief.id, title: brief.title, takeaway: `Research could not complete: ${reason}`, claims: [], sources: [], rag: 'red' };
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

  try {
    await orientWithReview({ target, tools: literatureTools, store, emit });
  } catch (err) {
    emit({ type: 'error', message: `orientation failed: ${String(err)}` });
  }

  emit({ type: 'lead_decompose', specialists: roster.map((b) => b.id) });
  const settled = await Promise.allSettled(roster.map((brief) =>
    produceResearchSection({ brief, target, tools: literatureTools, store, specialistModel, verifierModel, emit, budget }),
  ));
  const sections = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    const reason = String((r.reason as { message?: string })?.message ?? r.reason);
    emit({ type: 'error', message: `specialist ${roster[i].id} failed: ${reason}` });
    return placeholderSection(roster[i], reason);
  });

  let complete = true;
  let gaps: ResearchGap[] = [];
  try {
    ({ complete, gaps } = await assessCompleteness(sections, opts.leadModel));
  } catch (err) {
    emit({ type: 'error', message: `completeness assessment failed: ${String(err)}` });
  }
  emit({ type: 'completeness_verdict', complete, gaps: gaps.map((g) => g.question) });
  let finalSections = sections;
  if (!complete) {
    for (const gap of gaps) {
      const idx = finalSections.findIndex((s) => s.id === gap.specialistId);
      if (idx === -1) continue;
      try {
        const claims = await fillGap({ gap, target, tools: literatureTools, store, specialistModel, verifierModel, emit });
        finalSections = finalSections.map((s, i) => (i === idx ? mergeGapClaims(s, claims) : s));
      } catch (err) {
        emit({ type: 'error', message: `gap-fill ${gap.specialistId} failed: ${String(err)}` });
      }
    }
  }

  try {
    const mi = finalSections.findIndex((s) => s.id === 'modality_developability');
    if (mi !== -1) {
      const risks = await assessDevelopability({ section: finalSections[mi], store, model: verifierModel, emit });
      finalSections = finalSections.map((s, i) => (i === mi ? { ...s, developabilityRisks: risks } : s));
    }
  } catch (err) {
    emit({ type: 'error', message: `developability assessment failed: ${String(err)}` });
  }

  let weighing = { takeaway: '', claims: [] as Claim[] };
  try {
    weighing = await weighAcrossThreads({ sections: finalSections, store, leadModel: opts.leadModel, verifierModel, emit });
  } catch (err) {
    emit({ type: 'error', message: `weighing failed: ${String(err)}` });
  }
  return { target, sections: finalSections, weighing, evidence: store.all() };
}
