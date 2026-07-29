import type { Claim, ConclusionSupport, TraceEvent } from '@mrsirquanzo/sonny-shared';
import type { EvidenceStore } from '../evidenceStore.js';

/**
 * Derive `evidenceIds` from the citations of supporting claims.
 *
 * NEVER model-emitted. Claim ids and evidence ids are different namespaces, and
 * letting a model author evidence ids would reintroduce the phantom-citation
 * problem one layer above the grounding gate: the claims would all be real and
 * the conclusion would still cite a source that does not exist.
 *
 * Unresolvable ids are dropped rather than passed through, and the drop is
 * traced - a silently shortened citation list is indistinguishable from a
 * conclusion that was always thinly supported.
 */
export function deriveEvidenceIds(
  claims: readonly Claim[],
  supportingClaimIds: readonly string[],
  store: EvidenceStore,
): { evidenceIds: string[]; dropped: string[] } {
  const byId = new Map(claims.map((c) => [c.id, c]));
  const known = new Set(store.all().map((e) => e.id));
  const evidenceIds: string[] = [];
  const dropped: string[] = [];

  for (const claimId of supportingClaimIds) {
    const claim = byId.get(claimId);
    // A supporting claim id that names no surviving claim contributes no
    // citations. It is reported by the caller's verification check, not here.
    if (!claim) continue;
    for (const citation of claim.citations) {
      if (!known.has(citation)) { dropped.push(citation); continue; }
      if (!evidenceIds.includes(citation)) evidenceIds.push(citation);
    }
  }
  return { evidenceIds, dropped: [...new Set(dropped)] };
}

/**
 * Rebuild a conclusion's support so `evidenceIds` is derived, and report which
 * supporting claims did not survive verification.
 *
 * `deterministicClaims` count as support: section 7.4 permits a conclusion to
 * cite curated cards, which are asserted from a database and never pass through
 * the verifier. Excluding them here would degrade a conclusion that rests on
 * exactly the evidence the pipeline trusts most.
 */
export function resolveSupport(opts: {
  support: ConclusionSupport;
  verifiedClaims: readonly Claim[];
  deterministicClaims?: readonly Claim[];
  store: EvidenceStore;
  emit?: (e: TraceEvent) => void;
}): { support: ConclusionSupport; survivingClaimIds: string[]; allSupportLost: boolean } {
  const { support, verifiedClaims, deterministicClaims = [], store, emit } = opts;
  const usable = [...verifiedClaims, ...deterministicClaims];
  const usableIds = new Set(usable.map((c) => c.id));

  const survivingClaimIds = support.supportingClaimIds.filter((id) => usableIds.has(id));
  const { evidenceIds, dropped } = deriveEvidenceIds(usable, survivingClaimIds, store);

  if (dropped.length && emit) {
    emit({ type: 'error', message: `conclusion support: dropped unresolvable evidence ids ${dropped.join(', ')}` });
  }

  return {
    support: {
      supportingClaimIds: survivingClaimIds,
      evidenceIds,
      ...(support.retrievalAuditIds ? { retrievalAuditIds: support.retrievalAuditIds } : {}),
    },
    survivingClaimIds,
    // Only "lost" if it HAD support and none of it survived. A conclusion that
    // never claimed claim support - an absence standing on retrieval audits -
    // is not degraded by this rule.
    allSupportLost: support.supportingClaimIds.length > 0 && survivingClaimIds.length === 0,
  };
}
