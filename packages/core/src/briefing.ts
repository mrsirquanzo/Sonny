import type { Briefing, Reference, TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { Tool } from '@mrsirquanzo/sonny-mcp-gateway';
import type { StructuredModel } from './model.js';
import type { ThreadBrief, ResearchBudget, ResearchContext } from './researcher.js';
import { runDeepResearch, type DeepResearchResult } from './runDeepResearch.js';
import { synthesizeRecommendation } from './synthesize.js';

// One reference per underlying SOURCE, not per cited locator. Claims cite
// individual PMC full-text sections (PMCID:...#sec-4) and separate DB cards
// (ENSG...#expression, #tractability); listing each as its own reference makes
// one paper/source look like many rows (with section titles), which reads as
// padded/duplicated sources and erodes trust. Collapse by base id (strip the
// #locator) and give PMC/Open Targets/UniProt rows an honest source-typed label
// rather than a section title.
export function assembleReferences(result: DeepResearchResult): Reference[] {
  const cited = new Set<string>();
  for (const s of result.sections) for (const c of s.claims) for (const id of c.citations) cited.add(id);
  for (const c of result.weighing.claims) for (const id of c.citations) cited.add(id);
  const baseOf = (id: string) => id.replace(/#.*$/, '');
  const sourceLabel = (baseId: string, fallback: string): string => {
    if (baseId.startsWith('PMCID:')) return 'PubMed Central full text';
    if (baseId.startsWith('ENSG')) return 'Open Targets - target record';
    if (baseId.startsWith('UNIPROT:')) return 'UniProt - protein entry';
    return fallback; // PMID and similar carry a real paper title
  };
  const byBase = new Map<string, Reference>();
  for (const e of result.evidence) {
    if (!cited.has(e.id)) continue;
    const b = baseOf(e.id);
    if (byBase.has(b)) continue;
    if (e.kind === 'computation') {
      const { snippet: _snippet, passage: _passage, locator: _locator, raw: _raw, metadata: _metadata, ...reference } = e;
      byBase.set(b, reference);
    } else {
      byBase.set(b, {
        id: b,
        kind: e.kind,
        source: e.source,
        title: sourceLabel(b, e.title),
        url: e.url ? baseOf(e.url) : e.url,
      });
    }
  }
  return [...byBase.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function produceBriefing(opts: {
  target: string; roster: ThreadBrief[];
  literatureTools: Tool[]; structuredTools: Tool[];
  specialistModel: StructuredModel; verifierModel: StructuredModel; leadModel: StructuredModel;
  emit: (e: TraceEvent) => void; budget: ResearchBudget;
  context?: ResearchContext;
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
