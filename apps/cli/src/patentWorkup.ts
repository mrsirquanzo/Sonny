import { ingestToMarkdown } from '@sonny/mcp-gateway';
import type { IngestResult } from '@sonny/mcp-gateway';
import {
  extractPatentData, reconcilePatent, groupConstructs, buildWorkup, synthesizeCompetitiveIP, graphRelationships, makeModel,
} from '@sonny/core';
import type { StructuredModel, ReconcileDeps, PatentWorkup } from '@sonny/core';

export interface WorkupDeps {
  ingest?: (filePath: string) => Promise<IngestResult>;
  model?: StructuredModel;
  reconcileDeps?: ReconcileDeps;
}

export async function runPatentWorkup(
  filePath: string,
  deps: WorkupDeps = {},
): Promise<{ ok: true; workup: PatentWorkup } | { ok: false; error: string }> {
  const ingest = deps.ingest ?? ingestToMarkdown;
  const res = await ingest(filePath);
  if (res.status !== 'ok') return { ok: false, error: res.error ?? 'markitdown unavailable' };

  try {
    const model = deps.model ?? makeModel();
    const extracted = await extractPatentData(res.markdown, model);
    const reconciliation = await reconcilePatent(extracted, deps.reconcileDeps);
    const constructs = await groupConstructs(res.markdown, extracted.associations, model);
    const workup = buildWorkup(extracted, reconciliation, constructs);
    workup.narrative = await synthesizeCompetitiveIP(workup, model);
    workup.graph = graphRelationships(workup);
    return { ok: true, workup };
  } catch (e) {
    return { ok: false, error: `patent workup failed: ${(e as Error).message}` };
  }
}
