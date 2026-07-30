import type { Claim, ConclusionSupport } from '@mrsirquanzo/sonny-shared';
import type { EvidenceStore } from '../evidenceStore.js';
import { deriveEvidenceIds } from './support.js';

/**
 * Rewrite EVERY `support` object anywhere in a conclusion tree.
 *
 * Support is not at a fixed depth. Q2/Q4/Q5/Q6 hold one at
 * `assessment.support`; Q1 holds one per disease context; Q3 comparative buries
 * it at `conclusion.assessments[].rankedStrategies[].support`. Handling only
 * the shallow cases left the nested ones carrying model-authored `evidenceIds`
 * straight through the gate that exists to stop exactly that.
 *
 * Walking the tree instead of enumerating paths also means a new conclusion
 * shape cannot silently opt out of derivation by nesting its support somewhere
 * new.
 */
export function rewriteAllSupport<T>(
  node: T,
  usableClaims: readonly Claim[],
  store: EvidenceStore,
  onSupport?: (before: ConclusionSupport, after: ConclusionSupport) => void,
): T {
  if (Array.isArray(node)) {
    return node.map((n) => rewriteAllSupport(n, usableClaims, store, onSupport)) as unknown as T;
  }
  if (node === null || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'support' && isSupport(value)) {
      const rewritten = rewriteOne(value, usableClaims, store);
      onSupport?.(value, rewritten);
      out[key] = rewritten;
      continue;
    }
    out[key] = rewriteAllSupport(value, usableClaims, store, onSupport);
  }
  return out as T;
}

function isSupport(v: unknown): v is ConclusionSupport {
  return typeof v === 'object' && v !== null
    && Array.isArray((v as ConclusionSupport).supportingClaimIds);
}

/**
 * A model may name which claims it relied on; it may NOT name evidence.
 * `supportingClaimIds` is filtered to claims actually supplied, and
 * `evidenceIds` is discarded and rebuilt from those claims' citations - claim
 * ids and evidence ids are different namespaces, and letting a model author the
 * second reintroduces phantom citations one layer above the grounding gate.
 */
function rewriteOne(
  support: ConclusionSupport,
  usableClaims: readonly Claim[],
  store: EvidenceStore,
): ConclusionSupport {
  const usableIds = new Set(usableClaims.map((c) => c.id));
  const supportingClaimIds = support.supportingClaimIds.filter((id) => usableIds.has(id));
  const { evidenceIds } = deriveEvidenceIds(usableClaims, supportingClaimIds, store);
  return {
    supportingClaimIds,
    evidenceIds,
    ...(support.retrievalAuditIds ? { retrievalAuditIds: support.retrievalAuditIds } : {}),
  };
}

/** Did any support in the tree lose every claim it cited? */
export function anySupportFullyLost(
  before: ConclusionSupport[],
  after: ConclusionSupport[],
): boolean {
  return before.some((b, i) => b.supportingClaimIds.length > 0 && after[i].supportingClaimIds.length === 0);
}
