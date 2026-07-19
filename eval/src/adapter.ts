import type { Briefing, Evidence, TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { RunArtifacts, BriefingLike, EvidenceLike } from './metrics.js';

/**
 * Adapt the real @mrsirquanzo/sonny-shared Briefing (nested recommendation, CasePoint bull/bear)
 * plus the full evidence store into the metrics' engine-agnostic RunArtifacts.
 * This is the only place the eval package knows the core Briefing shape.
 */
export function toRunArtifacts(
  briefing: Briefing,
  evidence: Evidence[],
  events: TraceEvent[],
  elapsedMs: number,
): RunArtifacts {
  const briefingLike: BriefingLike = {
    verdict: briefing.recommendation.verdict,
    thesis: briefing.recommendation.thesis,
    executiveRead: briefing.executiveRead,
    bull: briefing.recommendation.bull.map((p) => p.point),
    bear: briefing.recommendation.bear.map((p) => p.point),
    sections: briefing.sections.map((s) => ({
      id: s.id,
      claims: s.claims,
      developabilityRisks: s.developabilityRisks,
    })),
    kolCluster: briefing.kolCluster
      ? { labs: briefing.kolCluster.labs.map((l) => ({ investigator: l.investigator, institution: l.institution })) }
      : undefined,
  };
  const evidenceById = new Map<string, EvidenceLike>(evidence.map((e) => {
    if (e.kind !== 'computation') {
      return [e.id, { id: e.id, kind: e.kind, passage: e.passage, snippet: e.snippet, title: e.title }];
    }
    return [e.id, {
      id: e.id, kind: e.kind, passage: e.passage, snippet: e.snippet, title: e.title,
      computationId: e.computationId, resultKeys: e.resultKeys,
      resultsJsonHash: e.resultsJsonHash, raw: e.raw, exitStatus: e.exitStatus,
    }];
  }));
  const figureReadings = events.flatMap((e) => (e.type === 'figure_read' ? e.readings : []));
  return { briefing: briefingLike, evidenceById, elapsedMs, figureReadings };
}
