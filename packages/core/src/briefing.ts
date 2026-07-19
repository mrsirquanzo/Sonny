import type { Briefing, Reference, TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import type { StructuredModel } from './model.js';
import type { ThreadBrief, ResearchBudget } from './researcher.js';
import { runDeepResearch, type DeepResearchResult } from './runDeepResearch.js';
import { synthesizeRecommendation } from './synthesize.js';

export function assembleReferences(result: DeepResearchResult): Reference[] {
  const cited = new Set<string>();
  for (const s of result.sections) for (const c of s.claims) for (const id of c.citations) cited.add(id);
  for (const c of result.weighing.claims) for (const id of c.citations) cited.add(id);
  return result.evidence
    .filter((e) => cited.has(e.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => {
      if (e.kind !== 'computation') {
        return { id: e.id, kind: e.kind, source: e.source, title: e.title, url: e.url };
      }
      const { snippet: _snippet, passage: _passage, locator: _locator, raw: _raw, metadata: _metadata, ...reference } = e;
      return reference;
    });
}

export async function produceBriefing(opts: {
  target: string; roster: ThreadBrief[];
  literatureTools: Tool[]; structuredTools: Tool[];
  specialistModel: StructuredModel; verifierModel: StructuredModel; leadModel: StructuredModel;
  emit: (e: TraceEvent) => void; budget: ResearchBudget;
}): Promise<Briefing> {
  const result = await runDeepResearch(opts);
  const { recommendation, executiveRead } = await synthesizeRecommendation({
    target: result.target, sections: result.sections, weighing: result.weighing, evidence: result.evidence, model: opts.leadModel,
    contradictions: result.contradictions,
  });
  opts.emit({ type: 'recommendation', verdict: recommendation.verdict });
  return {
    target: result.target, recommendation, executiveRead,
    sections: result.sections, weighing: result.weighing, references: assembleReferences(result),
    kolCluster: result.kolCluster,
  };
}
