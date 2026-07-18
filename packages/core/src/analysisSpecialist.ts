import {
  AnalysisResultsSchema,
  resolveResultBinding,
  sha256CanonicalJson,
  type Claim,
  type ComputationEvidence,
  type GroupPoint,
  type ScalarResult,
  type Section,
  type Verdict,
} from '@mrsirquanzo/sonny-shared';
import {
  runAnalysisTemplate,
  toComputationEvidence,
  type AnalysisArtifact,
  type AnalysisExecutionResult,
  type RunAnalysisTemplateInput,
} from '@mrsirquanzo/sonny-mcp-gateway';
import { z } from 'zod';
import { EvidenceStore } from './evidenceStore.js';
import { groundClaims } from './grounding.js';
import { createSourceIdentityResolver, computeRag } from './rag.js';
import { reproducibilityGate, type ReproducibilityDrop } from './reproducibilityGate.js';
import type { DeepResearchResult } from './runDeepResearch.js';
import type { Specialist } from './specialists.js';
import { currentBackend, routerFor, type StructuredModel } from './model.js';

export const ANALYSIS_SPECIALIST: Specialist = {
  id: 'data_analysis',
  title: 'Data analysis',
  objective: 'Run reviewed, sandboxed analysis templates over frozen datasets.',
  toolNames: ['run_analysis_template'],
  promptHint: 'Select only the target gene and a bounded analysis question. The reviewed template owns thresholds, tissues, exclusions, and tests.',
};

export const TROP2_DATASET_IDS = [
  'depmap.crispr_gene_effect',
  'gtex.median_tpm',
  'expr.tumor',
] as const;

export const TROP2_RESULT_KEYS = [
  'dependency.fraction_at_or_below_locked_cutoff',
  'tumor_expression.median_by_sample_class::tumor',
  'normal_tissue.maximum_tissue_median_tpm',
] as const;

export type AnalysisQuestion =
  | 'trop2_profile'
  | 'dependency'
  | 'tumor_expression'
  | 'normal_tissue_expression';

const AnalysisPlanSelectionSchema = z.object({
  templateId: z.literal('trop2_analysis'),
  target: z.literal('TACSTD2'),
  analysisQuestion: z.enum([
    'trop2_profile', 'dependency', 'tumor_expression', 'normal_tissue_expression',
  ]),
}).strict();

export interface AnalysisPlan {
  templateId: 'trop2_analysis';
  params: { target: 'TACSTD2'; analysisQuestion: AnalysisQuestion };
  datasetIds: readonly string[];
}

export type AnalysisSection = Extract<Section, { kind: 'analysis' }>;
export type AnalysisExecutor = (input: RunAnalysisTemplateInput) => Promise<AnalysisExecutionResult>;

export interface AnalysisSpecialistResult {
  section: AnalysisSection;
  evidence: ComputationEvidence[];
  dropped: ReproducibilityDrop[];
  abstentionReason?: string;
  failureKind?: 'docker_unavailable' | 'analysis_failed';
  verifiedRun?: VerifiedAnalysisRun;
}

export interface VerifiedAnalysisRun {
  originReplayVerification: 'verified';
  primaryResultHash: string;
  replayResultHash: string;
  artifacts: AnalysisArtifact[];
}

export interface RunAnalysisSpecialistInput {
  target: string;
  analysisQuestion?: AnalysisQuestion;
  timeoutMs?: number;
  executor?: AnalysisExecutor;
  planningModel?: StructuredModel;
  retrievedAt?: string;
}

/** Phase-1 registry selection: aliases normalize to the sole reviewed target. */
export function selectAnalysisPlan(
  target: string,
  analysisQuestion: AnalysisQuestion = 'trop2_profile',
): AnalysisPlan | undefined {
  const normalized = target.trim().toUpperCase();
  if (normalized !== 'TACSTD2' && normalized !== 'TROP2') return undefined;
  return {
    templateId: 'trop2_analysis',
    params: { target: 'TACSTD2', analysisQuestion },
    datasetIds: TROP2_DATASET_IDS,
  };
}

async function planWithBoundedModel(target: string, model: StructuredModel): Promise<AnalysisPlan | undefined> {
  const reviewed = selectAnalysisPlan(target);
  if (!reviewed) return undefined;
  const selection = AnalysisPlanSelectionSchema.parse(await model.generateStructured({
    system: [
      'You are Sonny\'s Phase-1 analysis planning specialist.',
      'Choose only from the supplied reviewed template contract.',
      'You may select the normalized target gene and bounded analysis question only.',
      'Never propose thresholds, tissues, exclusions, statistical tests, code, or dataset paths.',
    ].join(' '),
    prompt: `Plan the reviewed data analysis for target ${target}. Use trop2_profile for a general target request.`,
    schema: AnalysisPlanSelectionSchema,
    model: routerFor(currentBackend()).specialist,
  }));
  return {
    templateId: selection.templateId,
    params: { target: selection.target, analysisQuestion: selection.analysisQuestion },
    datasetIds: TROP2_DATASET_IDS,
  };
}

function abstain(
  reason: string,
  evidence: ComputationEvidence[] = [],
  dropped: ReproducibilityDrop[] = [],
  failureKind: AnalysisSpecialistResult['failureKind'] = 'analysis_failed',
): AnalysisSpecialistResult {
  return {
    section: {
      kind: 'analysis',
      id: 'data_analysis',
      title: 'Data analysis',
      takeaway: `Analysis abstained: ${reason}`,
      claims: [],
      sources: [],
      rag: 'red',
      computationIds: [],
      figurePaths: [],
    },
    evidence,
    dropped,
    abstentionReason: reason,
    failureKind,
  };
}

function requiredResult(
  results: AnalysisExecutionResult['resultsJson'],
  resultKey: string,
): (ScalarResult | GroupPoint) & { value: number } {
  const result = resolveResultBinding(results, resultKey);
  if (!result || result.value === null) throw new Error(`required typed result is missing: ${resultKey}`);
  return result as (ScalarResult | GroupPoint) & { value: number };
}

/** Map only reviewed result keys to scientifically bounded, structured claims. */
export function mapTrop2ResultsToClaims(
  results: AnalysisExecutionResult['resultsJson'],
  evidence: ComputationEvidence,
): Claim[] {
  const dependencyKey = TROP2_RESULT_KEYS[0];
  const tumorKey = TROP2_RESULT_KEYS[1];
  const normalKey = TROP2_RESULT_KEYS[2];
  const dependency = requiredResult(results, dependencyKey);
  const tumor = requiredResult(results, tumorKey);
  const normal = requiredResult(results, normalKey);
  const dependencyPercent = (dependency.value * 100).toFixed(Math.min(4, dependency.precision));
  const dependencyThreshold = dependency.threshold === null ? 'the locked cutoff' : String(dependency.threshold);

  return [
    {
      id: 'analysis-dependency-context',
      text: `In the frozen DepMap slice, ${dependencyPercent}% of ${dependency.sampleN} observed models had TACSTD2 gene effect at or below the template-locked ${dependencyThreshold} cutoff. This is descriptive tumor-biology context, not an ADC suitability criterion.`,
      citations: [evidence.id],
      confidence: 1,
      computedBinding: {
        computationId: evidence.computationId,
        resultKey: dependencyKey,
        assertedValue: dependency.value,
        assertedUnit: dependency.unit,
      },
    },
    {
      id: 'analysis-tumor-expression',
      text: `In the frozen cBioPortal breast-cancer slice, median TACSTD2 tumor expression was ${tumor.value.toFixed(tumor.precision)} ${tumor.unit} across ${tumor.sampleN} observed tumor samples. Tumor and normal signals are reported separately; no cross-source comparison is made.`,
      citations: [evidence.id],
      confidence: 1,
      computedBinding: {
        computationId: evidence.computationId,
        resultKey: tumorKey,
        assertedValue: tumor.value,
        assertedUnit: tumor.unit,
      },
    },
    {
      id: 'analysis-normal-tissue-screen',
      text: `Across ${normal.sampleN} GTEx normal tissues, the maximum tissue median TACSTD2 transcript signal was ${normal.value.toFixed(normal.precision)} ${normal.unit}. This is a screening flag for potential normal-tissue exposure risk requiring protein-level and clinical confirmation; it does not establish epithelial localization, surface protein, or toxicity.`,
      citations: [evidence.id],
      confidence: 1,
      computedBinding: {
        computationId: evidence.computationId,
        resultKey: normalKey,
        assertedValue: normal.value,
        assertedUnit: normal.unit,
      },
    },
  ];
}

function successful(result: AnalysisExecutionResult): boolean {
  return result.exitCode === 0 && !result.timedOut;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error);
}

function isDockerUnavailable(error: unknown): boolean {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) messages.push(current.message);
    if (typeof current === 'object') {
      const record = current as { code?: unknown; cause?: unknown };
      if (record.code === 'ENOENT' || record.code === 'ECONNREFUSED') return true;
      current = record.cause;
    } else break;
  }
  return /(?:SONNY_ANALYSIS_IMAGE|spawn\s+docker\s+ENOENT|docker[^\n]*(?:daemon|unavailable|not found|cannot connect|connection refused|is not running))/i
    .test(messages.join('\n'));
}

/**
 * Execute the reviewed analysis twice, then apply Slice 2 reproducibility,
 * computation-grounding, source-identity, and RAG gates in that order.
 */
export async function runAnalysisSpecialist(input: RunAnalysisSpecialistInput): Promise<AnalysisSpecialistResult> {
  let plan: AnalysisPlan | undefined;
  try {
    plan = input.planningModel && input.analysisQuestion === undefined
      ? await planWithBoundedModel(input.target, input.planningModel)
      : selectAnalysisPlan(input.target, input.analysisQuestion);
  } catch (error) {
    return abstain(`bounded analysis planning failed: ${errorMessage(error)}`);
  }
  if (!plan) return abstain(`no reviewed analysis template is available for ${input.target.trim() || 'the empty target'}`);

  const executor = input.executor ?? runAnalysisTemplate;
  const executionInput: RunAnalysisTemplateInput = {
    templateId: plan.templateId,
    params: plan.params,
    datasetIds: [...plan.datasetIds],
    timeoutMs: input.timeoutMs ?? 120_000,
  };

  try {
    const primary = await executor(executionInput);
    const replay = await executor(executionInput);
    if (!successful(primary) || !successful(replay)) {
      return abstain('the reviewed template did not complete successfully in both sandbox runs');
    }

    const primaryResults = AnalysisResultsSchema.parse(primary.resultsJson);
    const replayResults = AnalysisResultsSchema.parse(replay.resultsJson);
    if (primaryResults.target.symbol !== plan.params.target || replayResults.target.symbol !== plan.params.target) {
      return abstain('the typed result target did not match the selected reviewed target');
    }

    const evidence = toComputationEvidence(primary, {
      resultKeys: TROP2_RESULT_KEYS,
      retrievedAt: input.retrievedAt,
      title: 'TACSTD2 reviewed data analysis',
      snippet: 'Reproducibly re-executed, typed DepMap, cBioPortal, and GTEx results.',
    });
    const replayEvidence = toComputationEvidence(replay, {
      resultKeys: TROP2_RESULT_KEYS,
      retrievedAt: input.retrievedAt,
    });
    if (evidence.computationId !== replayEvidence.computationId) {
      return abstain('the replay did not use the same content-addressed computation manifest', [evidence]);
    }

    const drafted = mapTrop2ResultsToClaims(primaryResults, evidence);
    const reproduced = reproducibilityGate({
      claims: drafted,
      evidence: [evidence],
      primaryResults: { [evidence.computationId]: primaryResults },
      replayResults: { [evidence.computationId]: replayResults },
      executionMode: 'live',
    });

    const store = new EvidenceStore();
    store.register(evidence);
    const grounded = groundClaims(reproduced.shippable, store);
    const dropped = [
      ...reproduced.dropped,
      ...grounded.stripped.map(({ claim, reason }) => ({ claim, reason })),
    ];
    if (grounded.shippable.length !== drafted.length) {
      return abstain('one or more computed claims failed reproducibility or grounding', [evidence], dropped);
    }

    const verdicts: Verdict[] = grounded.shippable.map((claim) => ({
      claimId: claim.id,
      status: 'supported',
      rationale: 'Typed binding reproduced and resolved to valid computation evidence.',
    }));
    const resolveSourceIdentity = createSourceIdentityResolver(store.all());
    const rag = computeRag(grounded.shippable, verdicts, resolveSourceIdentity);
    const declaredFigures = new Set(primaryResults.artifacts.map((artifact) => artifact.path));
    const figurePaths = primary.artifacts
      .filter((artifact) => artifact.mediaType === 'image/png' && declaredFigures.has(artifact.path))
      .map((artifact) => artifact.hostPath);
    if (figurePaths.length === 0) return abstain('the verified run did not produce its declared figure', [evidence], dropped);

    return {
      section: {
        kind: 'analysis',
        id: 'data_analysis',
        title: 'Data analysis',
        takeaway: 'Three bounded TACSTD2 signals reproduced from frozen DepMap, cBioPortal, and GTEx inputs.',
        claims: grounded.shippable,
        sources: [evidence.id],
        rag,
        computationIds: [evidence.computationId],
        figurePaths,
      },
      evidence: [evidence],
      dropped,
      verifiedRun: {
        originReplayVerification: 'verified',
        primaryResultHash: sha256CanonicalJson(primaryResults),
        replayResultHash: sha256CanonicalJson(replayResults),
        artifacts: primary.artifacts,
      },
    };
  } catch (error) {
    return abstain(
      errorMessage(error), [], [], isDockerUnavailable(error) ? 'docker_unavailable' : 'analysis_failed',
    );
  }
}

/** Compose analysis into the same result consumed by Briefing/reference assembly. */
export function attachAnalysisToDeepResearch(
  result: DeepResearchResult,
  analysis: AnalysisSpecialistResult,
): DeepResearchResult {
  const evidenceById = new Map(result.evidence.map((item) => [item.id, item]));
  for (const item of analysis.evidence) evidenceById.set(item.id, item);
  return {
    ...result,
    sections: [...result.sections, analysis.section],
    evidence: [...evidenceById.values()],
  };
}
