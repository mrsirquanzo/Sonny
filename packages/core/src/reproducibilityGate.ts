import {
  AnalysisResultsSchema,
  ComputationEvidenceSchema,
  canonicalJson,
  resolveResultBinding,
  sha256CanonicalJson,
  type AnalysisResults,
  type Claim,
  type ComputationEvidence,
  type TypedResult,
} from '@mrsirquanzo/sonny-shared';

type ExecutionMode = 'live' | 'cached';

export interface ReproducibilityDrop {
  claim: Claim;
  reason: string;
}

export interface ReproducibilityGateResult {
  shippable: Claim[];
  dropped: ReproducibilityDrop[];
}

export interface ReproducibilityGateInput {
  claims: readonly Claim[];
  evidence: readonly ComputationEvidence[];
  primaryResults: Readonly<Record<string, unknown>>;
  replayResults?: Readonly<Record<string, unknown>>;
  executionMode: ExecutionMode;
  originVerification?: 'verified' | 'none';
}

function equalNullableNumber(left: number | null, right: number | null, tolerance: number): boolean {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= tolerance;
}

function sameTypedOutput(
  primary: NonNullable<ReturnType<typeof resolveResultBinding>>,
  replay: NonNullable<ReturnType<typeof resolveResultBinding>>,
): boolean {
  const { value: primaryValue, ...primaryContract } = primary;
  const { value: replayValue, ...replayContract } = replay;
  return canonicalJson(primaryContract) === canonicalJson(replayContract)
    && equalNullableNumber(primaryValue, replayValue, primary.tolerance);
}

function sameRunContract(primary: AnalysisResults, replay: AnalysisResults): boolean {
  const contract = (results: AnalysisResults) => ({
    schemaVersion: results.schemaVersion,
    templateId: results.templateId,
    templateVersion: results.templateVersion,
    target: results.target,
    lockedAnalysis: results.lockedAnalysis,
  });
  return canonicalJson(contract(primary)) === canonicalJson(contract(replay));
}

function sameTypedResult(primary: TypedResult, replay: TypedResult): boolean {
  if (primary.type !== replay.type) return false;
  if (primary.type === 'scalar' && replay.type === 'scalar') return sameTypedOutput(primary, replay);
  if (primary.type !== 'grouped-series' || replay.type !== 'grouped-series') return false;
  const { groups: primaryGroups, value: _primaryValue, ...primaryContract } = primary;
  const { groups: replayGroups, value: _replayValue, ...replayContract } = replay;
  if (canonicalJson(primaryContract) !== canonicalJson(replayContract)) return false;
  if (primaryGroups.length !== replayGroups.length) return false;
  return primaryGroups.every((group, index) =>
    group.key === replayGroups[index].key && sameTypedOutput(group, replayGroups[index]));
}

function allTypedOutputsReproduce(primary: AnalysisResults, replay: AnalysisResults): boolean {
  const primaryKeys = Object.keys(primary.results).sort();
  const replayKeys = Object.keys(replay.results).sort();
  if (canonicalJson(primaryKeys) !== canonicalJson(replayKeys)) return false;
  return primaryKeys.every((key) => sameTypedResult(primary.results[key], replay.results[key]));
}

function validateResultsForEvidence(
  raw: unknown,
  evidence: ComputationEvidence,
): AnalysisResults | undefined {
  const parsed = AnalysisResultsSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  if (parsed.data.templateId !== evidence.templateId || parsed.data.templateVersion !== evidence.templateVersion) {
    return undefined;
  }
  if (sha256CanonicalJson(parsed.data) !== evidence.resultsJsonHash) return undefined;
  return parsed.data;
}

/**
 * Deterministic reproducibility/grounding gate. It proves replay agreement,
 * not scientific correctness; correctness belongs to template review/goldens.
 */
export function reproducibilityGate(input: ReproducibilityGateInput): ReproducibilityGateResult {
  const evidenceByComputation = new Map<string, ComputationEvidence>();
  const computationEvidenceIds = new Set<string>();
  for (const candidate of input.evidence) {
    computationEvidenceIds.add(candidate.id);
    const parsed = ComputationEvidenceSchema.safeParse(candidate);
    if (parsed.success) {
      evidenceByComputation.set(parsed.data.computationId, parsed.data);
    }
  }

  const shippable: Claim[] = [];
  const dropped: ReproducibilityDrop[] = [];
  const drop = (claim: Claim, reason: string) => dropped.push({ claim, reason });

  for (const claim of input.claims) {
    const binding = claim.computedBinding;
    if (!binding) {
      if (claim.citations.some((citation) => computationEvidenceIds.has(citation))) {
        drop(claim, 'claim cites computation evidence without a structured binding');
        continue;
      }
      shippable.push(claim);
      continue;
    }
    const evidence = evidenceByComputation.get(binding.computationId);
    if (!evidence) { drop(claim, 'missing valid computation evidence'); continue; }
    if (!claim.citations.includes(evidence.id)) { drop(claim, 'claim does not cite its computation evidence'); continue; }
    if (!evidence.resultKeys.includes(binding.resultKey)) { drop(claim, 'result key is absent from computation evidence'); continue; }
    if (evidence.exitStatus.exitCode !== 0 || evidence.exitStatus.timedOut || evidence.exitStatus.signal !== null) {
      drop(claim, 'computation did not exit successfully'); continue;
    }

    const primary = validateResultsForEvidence(input.primaryResults[binding.computationId], evidence);
    if (!primary) { drop(claim, 'primary results failed schema, identity, or hash validation'); continue; }
    const primaryValue = resolveResultBinding(primary, binding.resultKey);
    if (!primaryValue || primaryValue.value === null) { drop(claim, 'bound result is missing or null'); continue; }
    if (primaryValue.unit !== binding.assertedUnit) { drop(claim, 'asserted unit does not match typed result'); continue; }
    if (Math.abs(primaryValue.value - binding.assertedValue) > primaryValue.tolerance) {
      drop(claim, 'asserted value does not match typed result'); continue;
    }

    if (input.executionMode === 'live') {
      const replayRaw = input.replayResults?.[binding.computationId];
      const replay = AnalysisResultsSchema.safeParse(replayRaw);
      if (!replay.success) { drop(claim, 'replay results failed schema validation'); continue; }
      if (!sameRunContract(primary, replay.data)) {
        drop(claim, 'replay run contract does not match the primary run'); continue;
      }
      if (!allTypedOutputsReproduce(primary, replay.data)) {
        drop(claim, 'replay output mismatched beyond the declared tolerance'); continue;
      }
      const replayValue = resolveResultBinding(replay.data, binding.resultKey);
      if (!replayValue || !sameTypedOutput(primaryValue, replayValue)) {
        drop(claim, 'replay output mismatched beyond the declared tolerance'); continue;
      }
      shippable.push({
        ...claim,
        executionMode: 'live', replayVerification: 'verified', originVerification: 'none',
      });
      continue;
    }

    if (input.originVerification !== 'verified') {
      drop(claim, 'cached computation lacks verified signed origin'); continue;
    }
    shippable.push({
      ...claim,
      executionMode: 'cached', replayVerification: 'not_run', originVerification: 'verified',
    });
  }
  return { shippable, dropped };
}
