import { ingestToMarkdown, blastVerifyTool, blastCacheFromEnv, cacheTtlMsFromEnv, makeCachedBlast } from '@mrsirquanzo/sonny-mcp-gateway';
import type { IngestResult, BlastCache, BlastFn } from '@mrsirquanzo/sonny-mcp-gateway';
import {
  extractPatentData, reconcilePatent, groupConstructs, buildWorkup, synthesizeCompetitiveIP, graphRelationships, makeModel, makeDecorrelatedVerifier, verifyNarrative, matchCdrCompetitors,
} from '@mrsirquanzo/sonny-core';
import type { StructuredModel, ReconcileDeps, PatentWorkup, Verifier, CdrBlast } from '@mrsirquanzo/sonny-core';

export interface WorkupDeps {
  ingest?: (filePath: string) => Promise<IngestResult>;
  model?: StructuredModel;
  reconcileDeps?: ReconcileDeps;
  verifier?: Verifier;
  cdrBlast?: CdrBlast;
  blastCache?: BlastCache;
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
    const rawBlast: BlastFn = (seq, db, opts) => blastVerifyTool.call({ sequence: seq, database: db, ...opts });
    const cache = deps.blastCache ?? blastCacheFromEnv();
    const blast = cache ? makeCachedBlast(rawBlast, cache, { maxAgeMs: cacheTtlMsFromEnv() }) : rawBlast;

    const extracted = await extractPatentData(res.markdown, model);
    const reconcileDeps = deps.reconcileDeps ?? { blast };
    const reconciliation = await reconcilePatent(extracted, reconcileDeps);
    const constructs = await groupConstructs(res.markdown, extracted.associations, model);
    const workup = buildWorkup(extracted, reconciliation, constructs);
    workup.narrative = await synthesizeCompetitiveIP(workup, model);
    const verifier = deps.verifier ?? makeDecorrelatedVerifier();
    workup.narrative = await verifyNarrative(workup.narrative, workup, verifier);
    const cdrBlast = deps.cdrBlast ?? blast;
    await matchCdrCompetitors(workup, reconciliation, cdrBlast);
    workup.graph = graphRelationships(workup);
    return { ok: true, workup };
  } catch (e) {
    return { ok: false, error: `patent workup failed: ${(e as Error).message}` };
  }
}
