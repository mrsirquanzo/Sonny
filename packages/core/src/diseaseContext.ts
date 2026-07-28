import {
  sha256CanonicalJson,
  type DiseaseContextKey,
  type Q1ContextAssessment,
  type Q3ContextAssessment,
} from '@mrsirquanzo/sonny-shared';

/**
 * Disease-context normalization.
 *
 * This module decides whether two findings are ABOUT THE SAME DISEASE. Every
 * failure mode is a silent wrong merge or a silent wrong split, so identity is
 * resolved deterministically and ambiguity is preserved rather than guessed.
 *
 * Canonical ontology: MONDO, release 2026-06-02. EFO/DOID/NCIt/Orphanet/MeSH
 * are alias layers reachable ONLY through explicit crossref mappings.
 */
export const ONTOLOGY_SOURCE = 'MONDO';
export const ONTOLOGY_VERSION = '2026-06-02';

export type CrossRefSource = 'MONDO' | 'EFO' | 'DOID' | 'NCIT' | 'ORPHANET' | 'MESH';
export type MappingRelation = 'exact' | 'narrow' | 'broad' | 'related';

export interface MondoTerm {
  ontologyId: string;
  canonicalName: string;
}

/**
 * Injectable ontology index.
 *
 * Deliberately NOT a network call: determinism must be a property of the
 * resolver, not of connectivity. A bundled fixture and an OLS-backed index
 * implement the same interface.
 */
export interface OntologyIndex {
  version: string;
  lookupExact(normalizedLabel: string): MondoTerm | undefined;
  lookupSynonym(normalizedLabel: string): MondoTerm[];
  lookupCrossRef(source: CrossRefSource, sourceId: string): (MondoTerm & { mappingRelation: MappingRelation }) | undefined;
  ancestorsOf(ontologyId: string): string[];
  candidatesFor?(normalizedLabel: string): Array<{ term: MondoTerm; reason: string }>;
}

export interface DiseaseContextInput {
  indication: string;
  biomarker?: { raw?: string; gene?: string; variant?: string };
  diseaseSubtype?: string;
  treatmentSetting?: string;
  lineOfTherapy?: string;
}

/** Conservative, purely lexical. Never resolver-dependent. */
function normalizeLabel(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}
function normalizeSymbol(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}
function normalizeFreeText(value?: string): string | undefined {
  const t = value?.trim().replace(/\s+/g, ' ').toLowerCase();
  return t ? t : undefined;
}

/** `EFO:0003060` / `DOID:3908` / `C2926` style source ids. */
function parseSourceId(raw: string): { source: CrossRefSource; sourceId: string } | undefined {
  const text = raw.trim();
  const m = text.match(/^(MONDO|EFO|DOID|NCIT|ORPHANET|ORPHA|MESH):(.+)$/i);
  if (m) {
    const upper = m[1].toUpperCase();
    const src = (upper === 'ORPHA' ? 'ORPHANET' : upper) as CrossRefSource;
    return { source: src, sourceId: text };
  }
  if (/^C\d+$/i.test(text)) return { source: 'NCIT', sourceId: text };
  return undefined;
}

/**
 * Build a `DiseaseContextKey`.
 *
 * Layer 1 is deterministic resolution; layer 2 preserves ambiguity. A model
 * may narrate an ambiguity, but nothing here lets one MUTATE identity.
 */
export function normalizeDiseaseContext(
  input: DiseaseContextInput,
  index: OntologyIndex,
): DiseaseContextKey {
  const raw = input.indication;
  const label = normalizeLabel(raw);

  const biomarker = input.biomarker?.gene || input.biomarker?.variant || input.biomarker?.raw
    ? {
        raw: input.biomarker.raw ?? [input.biomarker.gene, input.biomarker.variant].filter(Boolean).join(' '),
        canonicalName: [input.biomarker.gene, input.biomarker.variant]
          .filter(Boolean).map((v) => normalizeSymbol(v!)).join(' ') || normalizeSymbol(input.biomarker.raw ?? ''),
        ...(input.biomarker.gene ? { geneId: normalizeSymbol(input.biomarker.gene) } : {}),
        ...(input.biomarker.variant ? { variantId: normalizeSymbol(input.biomarker.variant) } : {}),
      }
    : undefined;

  const scaffold = {
    diseaseSubtype: normalizeFreeText(input.diseaseSubtype),
    treatmentSetting: normalizeFreeText(
      [input.treatmentSetting, input.lineOfTherapy].filter(Boolean).join(' | ') || undefined,
    ),
  };

  const finish = (
    resolved: { ontologyId?: string; canonicalName: string },
    mappingConfidence: DiseaseContextKey['mappingConfidence'],
    extras: Partial<DiseaseContextKey> = {},
  ): DiseaseContextKey => {
    // The id hashes NORMALIZED identity-bearing fields only. An unresolved
    // context still gets a stable id, derived from its raw label, so it can be
    // referenced and reconciled WITHOUT being merged into a neighbour.
    const canonicalContextId = sha256CanonicalJson({
      ontologyId: resolved.ontologyId ?? null,
      unresolvedLabel: resolved.ontologyId ? null : label,
      biomarker: biomarker ? { gene: biomarker.geneId ?? null, variant: biomarker.variantId ?? null } : null,
      diseaseSubtype: scaffold.diseaseSubtype ?? null,
      treatmentSetting: scaffold.treatmentSetting ?? null,
    });
    return {
      canonicalContextId,
      ontologySource: ONTOLOGY_SOURCE,
      ontologyVersion: index.version,
      indication: {
        raw,
        canonicalName: resolved.canonicalName,
        ...(resolved.ontologyId ? { ontologyId: resolved.ontologyId } : {}),
      },
      ...(biomarker ? { biomarker } : {}),
      ...(scaffold.diseaseSubtype ? { diseaseSubtype: scaffold.diseaseSubtype } : {}),
      ...(scaffold.treatmentSetting ? { treatmentSetting: scaffold.treatmentSetting } : {}),
      mappingConfidence,
      ...extras,
    } as DiseaseContextKey;
  };

  // Rule 2: exact MONDO label, then exact synonym.
  // Every resolution records HOW it matched, not only the crossref paths:
  // provenance is what makes rule 5 auditable after the fact.
  const exact = index.lookupExact(label);
  if (exact) {
    return finish(exact, 'exact', {
      mappingRelation: 'exact',
      matchedVia: { source: 'MONDO', sourceId: exact.ontologyId, labelOrSynonym: raw },
    } as Partial<DiseaseContextKey>);
  }

  const synonyms = index.lookupSynonym(label);
  if (synonyms.length === 1) {
    return finish(synonyms[0], 'exact', {
      mappingRelation: 'exact',
      matchedVia: { source: 'MONDO', sourceId: synonyms[0].ontologyId, labelOrSynonym: raw },
    } as Partial<DiseaseContextKey>);
  }
  if (synonyms.length > 1) {
    // Rule 6: never merge unresolved candidates.
    return finish({ canonicalName: label }, 'unresolved', {
      mappingRelation: 'unresolved',
      possibleMatches: synonyms.map((t) => ({
        canonicalContextId: t.ontologyId,
        reason: `ambiguous synonym "${raw}" matches ${t.canonicalName}`,
      })),
    });
  }

  // Rule 3: source ids resolve ONLY through an explicit crossref mapping.
  const parsed = parseSourceId(raw);
  if (parsed) {
    const hit = index.lookupCrossRef(parsed.source, parsed.sourceId);
    if (hit) {
      // Rule 5: a broad/narrow/related mapping is NOT equivalence and must not
      // be recorded as 'exact'. This is the most dangerous rule to get wrong.
      const confidence = hit.mappingRelation === 'exact' ? 'exact' : 'inferred';
      return finish(hit, confidence, {
        mappingRelation: hit.mappingRelation,
        matchedVia: { source: parsed.source, sourceId: parsed.sourceId, labelOrSynonym: raw },
      } as Partial<DiseaseContextKey>);
    }
    // Rule 8: an id absent from the index is never accepted.
    return finish({ canonicalName: label }, 'unresolved', {
      mappingRelation: 'unresolved',
      possibleMatches: [{ canonicalContextId: parsed.sourceId, reason: `no ${parsed.source} mapping to MONDO in ${index.version}` }],
    });
  }

  const candidates = index.candidatesFor?.(label) ?? [];
  return finish({ canonicalName: label }, 'unresolved', {
    mappingRelation: 'unresolved',
    possibleMatches: candidates.length
      ? candidates.map((c) => ({ canonicalContextId: c.term.ontologyId, reason: c.reason }))
      : [{ canonicalContextId: `unresolved:${label}`, reason: `no MONDO label, synonym, or crossref matched "${raw}"` }],
  });
}

/**
 * Equivalence for reconciliation.
 *
 * Rule 7: parent-child is DIRECTIONAL, not interchangeable. A lung
 * adenocarcinoma finding does not satisfy an NSCLC context, and NSCLC does not
 * satisfy lung adenocarcinoma. Equivalence therefore requires the SAME id, and
 * ancestry is exposed separately for deliberate, directional aggregation.
 */
export function contextsAreEquivalent(a: DiseaseContextKey, b: DiseaseContextKey): boolean {
  return a.canonicalContextId === b.canonicalContextId;
}

/**
 * Directional relation between two contexts.
 *
 * Returns the DIRECTION explicitly so a caller can never accidentally treat a
 * parent-child relationship as equivalence: a lung-adenocarcinoma finding is
 * `narrower` than an NSCLC context, and NSCLC is `broader` than it. Neither
 * satisfies the other, and the two calls are not symmetric.
 */
export function diseaseContextRelation(
  a: DiseaseContextKey,
  b: DiseaseContextKey,
  index: OntologyIndex,
): 'equivalent' | 'narrower' | 'broader' | 'unrelated' {
  if (a.canonicalContextId === b.canonicalContextId) return 'equivalent';
  const idA = a.indication.ontologyId;
  const idB = b.indication.ontologyId;
  if (!idA || !idB) return 'unrelated';
  if (index.ancestorsOf(idA).includes(idB)) return 'narrower';
  if (index.ancestorsOf(idB).includes(idA)) return 'broader';
  return 'unrelated';
}

/** Directional: is `descendant` a subtype of `ancestor`? Never symmetric. */
export function isDescendantOf(
  descendant: DiseaseContextKey,
  ancestor: DiseaseContextKey,
  index: OntologyIndex,
): boolean {
  const child = descendant.indication.ontologyId;
  const parent = ancestor.indication.ontologyId;
  if (!child || !parent || child === parent) return false;
  return index.ancestorsOf(child).includes(parent);
}

export interface ReconciledContext {
  context: DiseaseContextKey;
  q1?: Q1ContextAssessment;
  q3?: Q3ContextAssessment;
  status: 'evaluated_by_both' | 'only_q1' | 'only_q3' | 'ambiguous';
  conflicting: boolean;
}

/**
 * Join Q1 and Q3 assessments by normalized context.
 *
 * `confidence` and `evidenceAvailability` are carried through untouched and are
 * never folded into the status: "strong / low-confidence" and "strong /
 * high-confidence" are different findings.
 */
export function reconcileContextAssessments(
  q1Assessments: readonly Q1ContextAssessment[],
  q3Assessments: readonly Q3ContextAssessment[],
): ReconciledContext[] {
  const opts = { q1: q1Assessments, q3: q3Assessments };
  const byId = new Map<string, ReconciledContext>();
  const put = (context: DiseaseContextKey): ReconciledContext => {
    const existing = byId.get(context.canonicalContextId);
    if (existing) return existing;
    const created: ReconciledContext = { context, status: 'only_q1', conflicting: false };
    byId.set(context.canonicalContextId, created);
    return created;
  };

  for (const a of opts.q1) { const e = put(a.context); e.q1 = a; }
  for (const a of opts.q3) { const e = put(a.context); e.q3 = a; }

  for (const entry of byId.values()) {
    if (entry.context.mappingConfidence === 'unresolved') entry.status = 'ambiguous';
    else if (entry.q1 && entry.q3) entry.status = 'evaluated_by_both';
    else if (entry.q3) entry.status = 'only_q3';
    else entry.status = 'only_q1';

    // Disagreement between biological validity and clinical attractiveness is
    // a REPORTED finding, not something to average away.
    if (entry.q1 && entry.q3) {
      const weakValidity = entry.q1.validity === 'weak' || entry.q1.validity === 'unsupported';
      const strongOpportunity = entry.q3.opportunity === 'strong';
      const strongValidity = entry.q1.validity === 'strong';
      const weakOpportunity = entry.q3.opportunity === 'weak' || entry.q3.opportunity === 'unsupported';
      entry.conflicting = (weakValidity && strongOpportunity) || (strongValidity && weakOpportunity);
    }
  }
  return [...byId.values()];
}
