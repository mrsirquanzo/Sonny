import { sha256CanonicalJson } from './computationManifest.js';
import type {
  BiologicalIntent, TargetEngagement, TargetIdentity, TargetRole, TherapeuticIntervention,
} from './strategy.js';

/** SHA-256 content hash. THE strategy identity. Always present. */
export type StrategyFingerprint = string;
/** Run-local presentation ordinal ("V1", "V2"). Never carries identity. */
export type StrategyVariantLabel = string;
/** SHA-256 over (target identity, role, intent). Q1 reuse key. */
export type Q1HypothesisKey = string;

/**
 * Lexical-only normalization.
 *
 * HGNC and IMGT/HLA mappings are deliberately NOT applied here. An upstream
 * database release renaming a symbol would otherwise silently change the
 * fingerprint of an already-stored strategy, breaking Q1 reuse and caching
 * against historical runs with nothing to show why. Resolver mappings are
 * stored as provenance beside the identity, never folded into the hash.
 */
export function normalizeTargetIdentity(target: TargetIdentity): TargetIdentity {
  const sym = (s: string): string => s.trim().toUpperCase();
  // Normalize BEFORE testing presence: a whitespace-only optional field is
  // semantically an omission, and treating it as present gave two equivalent
  // identities different fingerprints.
  const opt = (v: string | undefined): string | undefined => {
    const n = v === undefined ? undefined : sym(v);
    return n === undefined || n === '' ? undefined : n;
  };
  switch (target.kind) {
    case 'gene_or_protein':
      return {
        kind: 'gene_or_protein',
        symbol: sym(target.symbol),
        ...(opt(target.targetForm) ? { targetForm: opt(target.targetForm)! } : {}),
      };
    case 'peptide_hla':
      return {
        kind: 'peptide_hla',
        sourceGene: sym(target.sourceGene),
        ...(opt(target.variant) ? { variant: opt(target.variant)! } : {}),
        ...(opt(target.peptide) ? { peptide: opt(target.peptide)! } : {}),
        hlaAllele: normalizeHlaAllele(target.hlaAllele),
      };
    case 'fusion':
      // Partner order is biologically meaningful: BCR-ABL1 is not ABL1-BCR.
      // Never sorted.
      return { kind: 'fusion', partners: [sym(target.partners[0]), sym(target.partners[1])] };
    case 'other':
      return { kind: 'other', canonicalName: target.canonicalName.trim().toLowerCase() };
  }
}

/** One lexical representation: uppercase, `HLA-` prefix, `*` and `:` separators. */
export function normalizeHlaAllele(allele: string): string {
  let t = allele.trim().toUpperCase().replace(/^HLA[-_]?/, '').replace(/_/g, ':').replace(/\s+/g, '');

  // Insert the locus separator for common compact or partially formatted forms:
  // A0201, A02:01 and DQB10602 become A*02:01 and DQB1*06:02.
  if (!t.includes('*')) {
    const compact = t.match(/^([A-Z][A-Z0-9]*?)(\d{2}):?(\d{2})(?::?(\d{2}))?$/);
    if (compact) {
      const [, locus, field1, field2, field3] = compact;
      t = `${locus}*${field1}:${field2}${field3 ? `:${field3}` : ''}`;
    }
  } else {
    const [locus, fields = ''] = t.split('*', 2);
    const digits = fields.replace(/:/g, '');
    if (/^\d{4}(?:\d{2})?$/.test(digits)) {
      t = `${locus}*${digits.slice(0, 2)}:${digits.slice(2, 4)}${digits.length > 4 ? `:${digits.slice(4, 6)}` : ''}`;
    }
  }

  return `HLA-${t}`;
}

function canonicalEngagement(e: TargetEngagement): unknown {
  return {
    target: normalizeTargetIdentity(e.target),
    targetRole: e.targetRole,
    primaryAction: e.primaryAction,
    secondaryActions: [...new Set(e.secondaryActions ?? [])].sort(),
    biologicalIntents: [...new Set(e.biologicalIntents)].sort(),
  };
}

/** Deterministic engagement ordering, so array order cannot change identity. */
export function normalizeAndSortEngagements(engagements: TargetEngagement[]): TargetEngagement[] {
  return [...engagements].sort((a, b) =>
    sha256CanonicalJson(canonicalEngagement(a)).localeCompare(sha256CanonicalJson(canonicalEngagement(b))),
  );
}

export function strategyFingerprint(intervention: TherapeuticIntervention): StrategyFingerprint {
  return sha256CanonicalJson({
    modality: intervention.modality,
    modalitySubtype: intervention.modalitySubtype ?? null,
    engagements: normalizeAndSortEngagements(intervention.engagements).map(canonicalEngagement),
  });
}

export function q1HypothesisKey(
  target: TargetIdentity,
  targetRole: TargetRole,
  biologicalIntent: BiologicalIntent,
): Q1HypothesisKey {
  return sha256CanonicalJson({
    target: normalizeTargetIdentity(target),
    targetRole,
    biologicalIntent,
  });
}

/**
 * Every (target, role, intent) triple across every engagement. A bispecific
 * with two engagements contributes two hypotheses, so H is independent of the
 * number of strategy variants rather than bounded by it.
 */
export function q1HypothesesFor(intervention: TherapeuticIntervention): Array<{
  key: Q1HypothesisKey; target: TargetIdentity; targetRole: TargetRole; biologicalIntent: BiologicalIntent;
}> {
  const out = new Map<string, { key: string; target: TargetIdentity; targetRole: TargetRole; biologicalIntent: BiologicalIntent }>();
  for (const e of intervention.engagements) {
    for (const intent of e.biologicalIntents) {
      const key = q1HypothesisKey(e.target, e.targetRole, intent);
      if (!out.has(key)) out.set(key, { key, target: e.target, targetRole: e.targetRole, biologicalIntent: intent });
    }
  }
  return [...out.values()];
}
