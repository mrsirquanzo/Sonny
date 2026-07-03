import { ingestToMarkdown, blastVerifyTool } from '@mrsirquanzo/sonny-mcp-gateway';
import {
  extractPatentData, reconcilePatent, groupConstructs, buildWorkup, synthesizeCompetitiveIP,
  graphRelationships, matchCdrCompetitors, AnthropicModel, makeDecorrelatedVerifier, verifyNarrative,
} from '@mrsirquanzo/sonny-core';
import type { PatentWorkup } from '@mrsirquanzo/sonny-core';
import type { GoldenPatent } from './goldenPatent.js';
import { scorePatent, type PatentMetrics } from './patentScore.js';
import type { LiveCapabilities } from './liveGate.js';

export interface LiveRunReport {
  name: string;
  groundTruthVerified: boolean;
  metrics: PatentMetrics;
  capabilities: LiveCapabilities;
  notes: string[];
}

// Composes the real pipeline inside eval (eval cannot import apps/cli). Tool deps default to the real
// tools inside reconcilePatent, which soft-degrade on their own (EPO_CONFIG_MISSING / anarci_unavailable).
export async function runLivePatent(golden: GoldenPatent, patentFile: string, caps: LiveCapabilities): Promise<LiveRunReport> {
  const notes: string[] = [];
  const res = await ingestToMarkdown(patentFile);
  if (res.status !== 'ok') throw new Error(`ingest failed for ${patentFile}: ${res.error ?? 'unknown'}`);
  const model = new AnthropicModel();
  const extracted = await extractPatentData(res.markdown, model);
  const reconciliation = await reconcilePatent(extracted);  // real blast/anarci/epo defaults
  const constructs = await groupConstructs(res.markdown, extracted.associations, model);
  const workup: PatentWorkup = buildWorkup(extracted, reconciliation, constructs);
  workup.narrative = await synthesizeCompetitiveIP(workup, model);
  workup.narrative = await verifyNarrative(workup.narrative, workup, makeDecorrelatedVerifier());
  const cdrBlast = (seq: string, db: string, opts?: { wordSize?: number; matrix?: string; expect?: number }) =>
    blastVerifyTool.call({ sequence: seq, database: db, ...opts });
  await matchCdrCompetitors(workup, reconciliation, cdrBlast);
  workup.graph = graphRelationships(workup);
  if (!caps.epo) notes.push('EPO disabled: patent identity/family/legal not verified this run');
  if (!caps.anarci) notes.push('ANARCI disabled: region/species confirmation degraded');
  return { name: golden.name, groundTruthVerified: golden.groundTruthVerified === true, metrics: scorePatent(workup, golden), capabilities: caps, notes };
}
