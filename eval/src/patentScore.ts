import type { PatentWorkup } from '@mrsirquanzo/sonny-core';
import type { GoldenPatent } from './goldenPatent.js';
import {
  extractionRecall, residueFidelity, setRecall, speciesAccuracy, pairingAccuracy,
  competitorRecall, competitorPrecision,
} from './goldenPatent.js';
import { gotConstructs, gotCompetitorOverlaps } from './patentPipeline.js';

export interface PatentMetrics {
  extractionRecall: number; residueFidelity: number;
  assigneeRecall: number; familyRecall: number;
  speciesAccuracy: number; pairingAccuracy: number;
  competitorRecallWhole: number; competitorRecallCdr: number;
  competitorPrecisionWhole: number; competitorPrecisionCdr: number;
}

export function scorePatent(workup: PatentWorkup, golden: GoldenPatent): PatentMetrics {
  const foundSeqIds = golden.knownSequences.map((k) => k.seqId).filter((id) =>
    workup.constructs.some((c) => c.regions.some((r) => r.seqId === id)));
  const extracted = workup.constructs.flatMap((c) => c.regions.map((r) => ({ seqId: r.seqId, residues: r.residues })));
  const gc = gotConstructs(workup);
  const overlaps = gotCompetitorOverlaps(workup);
  return {
    extractionRecall: extractionRecall(foundSeqIds, golden.declaredSequenceCount),
    residueFidelity: residueFidelity(extracted, golden.knownSequences),
    assigneeRecall: setRecall(workup.patent.applicants ?? [], golden.expectedAssignees),
    familyRecall: setRecall(workup.patent.family ?? [], golden.expectedFamilyMembers),
    speciesAccuracy: speciesAccuracy(gc, golden.expectedConstructs),
    pairingAccuracy: pairingAccuracy(gc, golden.expectedConstructs),
    competitorRecallWhole: competitorRecall(overlaps, golden.expectedCompetitorOverlaps, 'whole'),
    competitorRecallCdr: competitorRecall(overlaps, golden.expectedCompetitorOverlaps, 'cdr'),
    competitorPrecisionWhole: competitorPrecision(overlaps, golden.expectedCompetitorOverlaps, 'whole'),
    competitorPrecisionCdr: competitorPrecision(overlaps, golden.expectedCompetitorOverlaps, 'cdr'),
  };
}
