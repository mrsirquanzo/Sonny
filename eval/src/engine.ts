import type { Briefing, TraceEvent } from '@mrsirquanzo/sonny-shared';
import {
  runDeepResearch, synthesizeRecommendation, assembleReferences,
  makeModel, currentBackend, RESEARCH_ROSTER,
} from '@mrsirquanzo/sonny-core';
import {
  europePmcSearchTool, pmcFullTextTool, europePmcCitationsTool,
  openTargetsTargetTool, clinicalTrialsTool,
} from '@mrsirquanzo/sonny-mcp-gateway';
import { toRunArtifacts } from './adapter.js';
import type { RunArtifacts } from './metrics.js';

/**
 * Build the eval's runOnce(target): the ONLY coupling to @mrsirquanzo/sonny-core. Mirrors
 * apps/cli/src/deep.ts, but composes runDeepResearch + synthesizeRecommendation
 * directly so the full evidence store (not just cited references) is available
 * to the retrieval/grounding metrics.
 */
export function makeRunOnce(): (target: string) => Promise<RunArtifacts> {
  return async (target: string): Promise<RunArtifacts> => {
    const events: TraceEvent[] = [];
    const emit = (e: TraceEvent) => events.push(e);
    const leadModel = makeModel();
    const t0 = Date.now();
    const result = await runDeepResearch({
      target,
      roster: RESEARCH_ROSTER,
      literatureTools: [europePmcSearchTool, pmcFullTextTool, europePmcCitationsTool],
      structuredTools: [openTargetsTargetTool, clinicalTrialsTool],
      specialistModel: makeModel(),
      verifierModel: makeModel(),
      leadModel,
      emit,
      budget: { maxRounds: 4 },
      context: { modality: 'ADC' },
    });
    const { recommendation, executiveRead } = await synthesizeRecommendation({
      target, sections: result.sections, weighing: result.weighing, evidence: result.evidence, model: leadModel,
      contradictions: result.contradictions,
    });
    const briefing: Briefing = {
      target, recommendation, executiveRead,
      sections: result.sections, weighing: result.weighing,
      references: assembleReferences(result), kolCluster: result.kolCluster,
    };
    return toRunArtifacts(briefing, result.evidence, events, Date.now() - t0);
  };
}

export { currentBackend };
