import {
  CachedAnalysisBundleError,
  createSignedCachedAnalysisBundle,
  loadSignedCachedAnalysisBundle,
  makeModel,
  runAnalysisSpecialist,
  type AnalysisSpecialistResult,
  type RunAnalysisSpecialistInput,
} from '@mrsirquanzo/sonny-core';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Analyze = (input: RunAnalysisSpecialistInput) => Promise<AnalysisSpecialistResult>;
type LoadCached = (target: string) => Promise<AnalysisSpecialistResult | undefined>;

export interface RunAnalyzeDependencies {
  analyze?: Analyze;
  loadCached?: LoadCached;
  write?: (text: string) => void;
}

export function renderAnalysisSection(result: AnalysisSpecialistResult): string {
  const { section } = result;
  const representative = section.claims.find((claim) => claim.computedBinding);
  const verificationLabel = representative?.executionMode === 'cached'
    ? 'CACHED / ORIGIN VERIFIED'
    : representative?.executionMode === 'live' && representative.replayVerification === 'verified'
      ? 'LIVE / REPLAY VERIFIED'
      : 'UNVERIFIED / ABSTAINED';
  const lines = [
    `=== [${section.rag.toUpperCase()}] ${section.title} ===`,
    `Takeaway: ${section.takeaway}`,
  ];
  if (representative?.executionMode === 'cached') {
    lines.push('NOTICE: Signed cached replay; Docker was unavailable and no analysis ran on this machine.');
  }
  if (section.claims.length > 0) lines.push('', 'Claims (bounded):');
  for (const claim of section.claims) {
    lines.push(`  - ${claim.text}`, `    ${claim.citations.map((id) => `[${id}]`).join(' ')}`);
  }

  if (section.figurePaths.length > 0) {
    lines.push('', 'Figure artifacts:');
    for (const path of section.figurePaths) lines.push(`  - ${path}`);
  }

  const computationById = new Map(result.evidence.map((item) => [item.computationId, item]));
  if (section.computationIds.length > 0) {
    lines.push('', `Verification: ${verificationLabel}`, 'Provenance:');
    for (const computationId of section.computationIds) {
      const evidence = computationById.get(computationId);
      lines.push(`  computationId: ${computationId}`);
      if (!evidence) {
        lines.push('  verification  : unavailable (computation evidence did not resolve)');
        continue;
      }
      lines.push('  dataset hashes:');
      for (const dataset of evidence.datasetInputs) {
        lines.push(`    - ${dataset.datasetId}: ${dataset.contentSha256}`);
      }
      const claim = section.claims.find((candidate) =>
        candidate.computedBinding?.computationId === computationId);
      lines.push(`  execution mode : ${claim?.executionMode ?? 'unverified'}`);
      lines.push(`  replay         : ${claim?.replayVerification ?? 'not_run'}`);
      lines.push(`  origin         : ${claim?.originVerification ?? 'none'}`);
    }
  } else {
    lines.push('', `Verification: ${verificationLabel}`, 'Provenance: unavailable because the analysis abstained.');
  }
  return lines.join('\n');
}

function normalizedCacheTarget(target: string): string {
  const normalized = target.trim().toUpperCase();
  return normalized === 'TROP2' ? 'TACSTD2' : normalized.replace(/[^A-Z0-9_-]/g, '_');
}

async function loadDefaultCachedAnalysis(target: string): Promise<AnalysisSpecialistResult | undefined> {
  const cacheDirectory = resolve(process.env.SONNY_ANALYSIS_CACHE_DIR
    ?? join(process.cwd(), '.sonny', 'analysis-cache'));
  const bundlePath = join(cacheDirectory, `${normalizedCacheTarget(target)}.cached-run.json`);
  if (!existsSync(bundlePath)) return undefined;
  const allowed = process.env.SONNY_ALLOW_HISTORICALLY_VERIFIED_CACHE?.trim().toLowerCase() !== 'false';
  return loadSignedCachedAnalysisBundle({
    bundlePath,
    artifactRoot: join(cacheDirectory, 'artifacts'),
    allowHistoricallyVerifiedCachedClaims: allowed,
    expectedTarget: normalizedCacheTarget(target),
  });
}

function rejectedFallback(result: AnalysisSpecialistResult, error: unknown): AnalysisSpecialistResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ...result,
    section: {
      kind: 'analysis', id: 'data_analysis', title: 'Data analysis',
      takeaway: `Analysis abstained: signed cached fallback rejected (${message})`,
      claims: [], sources: [], rag: 'red', computationIds: [], figurePaths: [],
    },
    evidence: [],
    dropped: [],
    abstentionReason: `signed cached fallback rejected: ${message}`,
    failureKind: 'analysis_failed',
  };
}

export async function runAnalyze(target: string, dependencies: RunAnalyzeDependencies = {}): Promise<AnalysisSpecialistResult> {
  const write = dependencies.write ?? ((text: string) => process.stdout.write(text));
  let result = dependencies.analyze
    ? await dependencies.analyze({ target })
    : await runAnalysisSpecialist({ target, planningModel: makeModel() });
  if (result.failureKind === 'docker_unavailable') {
    try {
      result = await (dependencies.loadCached ?? loadDefaultCachedAnalysis)(target) ?? result;
    } catch (error) {
      result = rejectedFallback(result, error);
    }
  }

  const cacheOut = process.env.SONNY_ANALYSIS_CACHE_OUT?.trim();
  const signingKeyPath = process.env.SONNY_ANALYSIS_SIGNING_KEY_PATH?.trim();
  if (result.verifiedRun && (cacheOut || signingKeyPath)) {
    if (!cacheOut || !signingKeyPath) {
      throw new CachedAnalysisBundleError(
        'SONNY_ANALYSIS_CACHE_OUT and SONNY_ANALYSIS_SIGNING_KEY_PATH must be set together',
      );
    }
    createSignedCachedAnalysisBundle({
      result,
      outputPath: resolve(cacheOut),
      privateKeyPem: readFileSync(resolve(signingKeyPath), 'utf8'),
    });
  }
  write(`${renderAnalysisSection(result)}\n`);
  if (result.verifiedRun && cacheOut) write(`Signed cached bundle: ${resolve(cacheOut)}\n`);
  return result;
}
