import {
  extractPatentData, reconcilePatent, groupConstructs, buildWorkup, synthesizeCompetitiveIP, graphRelationships,
} from '@mrsirquanzo/sonny-core';
import type { StructuredModel, ReconcileDeps, PatentWorkup } from '@mrsirquanzo/sonny-core';
import type { GoldenCompetitor, SpeciesClass } from './goldenPatent.js';

// Compose the core pipeline offline (no ingest/CLI); all tool + model calls are injected.
export async function runPatentPipeline(
  markdown: string,
  deps: { model: StructuredModel; reconcileDeps?: ReconcileDeps },
): Promise<PatentWorkup> {
  const extracted = await extractPatentData(markdown, deps.model);
  const reconciliation = await reconcilePatent(extracted, deps.reconcileDeps);
  const constructs = await groupConstructs(markdown, extracted.associations, deps.model);
  const workup = buildWorkup(extracted, reconciliation, constructs);
  workup.narrative = await synthesizeCompetitiveIP(workup, deps.model);
  workup.graph = graphRelationships(workup);
  return workup;
}

export function gotConstructs(workup: PatentWorkup): Array<{ vhSeqId?: number; vlSeqId?: number; species: SpeciesClass }> {
  return workup.constructs.map((c) => ({
    vhSeqId: c.regions.find((r) => r.regionLabel === 'VH')?.seqId,
    vlSeqId: c.regions.find((r) => r.regionLabel === 'VL')?.seqId,
    species: c.species.classification,
  }));
}

export function gotCompetitorOverlaps(workup: PatentWorkup): GoldenCompetitor[] {
  return workup.graph
    .filter((e) => e.predicate === 'MATCHES')
    .map((e) => ({
      seqId: Number(e.subject.replace('SEQ:', '')),
      competitorAccession: e.object,
      level: e.provenance === 'blast-cdr-h3' ? ('cdr' as const) : ('whole' as const),
    }));
}
