import type { Claim, Section, Verdict } from '@mrsirquanzo/sonny-shared';
import type { EvidenceStore } from './evidenceStore.js';
import { computeRag, createSourceIdentityResolver, type SourceIdentityResolver } from './rag.js';

/**
 * Deterministically turn curated database evidence (Open Targets, UniProt) into
 * grounded, cited claims and route each to the section that owns its question.
 *
 * Why deterministic: the surface-localisation, normal-tissue-expression,
 * tractability and safety cards are the ADC-critical answers, but a small local
 * writer model reliably cites literature PMIDs and ignores these curated cards.
 * Rather than hope the LLM cites them, we assert them from the card itself -
 * reproducible, non-hallucinated, and always cited to the source card id. The
 * card snippets are already written as assertions, so the claim text is the
 * snippet verbatim and the citation is the card id (which resolves in the store,
 * so the grounding gate passes).
 *
 * Routing is the ROUTES table below, which is normative (spec 7.3).
 */
/**
 * Spec section 7.3, normative. A card may reach MORE THAN ONE axis: the same
 * neutral fact answers different questions, and the boundary is enforced by
 * each axis's prompt, not by starving axes of evidence.
 *
 * `#expression` reaching Q6 is the one that matters most. Normal-tissue
 * expression is the only fact grounding on-target/off-tumour liability, and
 * routing it solely to `disease_indications` left the developability reviewer
 * unable to see it at all.
 *
 * `#tractability` is Q2, not Q6: tractability is mechanistic feasibility, and
 * Q6 owns liability rather than feasibility.
 */
const ROUTES: Array<{ match: RegExp; sections: readonly string[] }> = [
  { match: /#domains$/, sections: ['target_biology'] },
  { match: /#localization$/, sections: ['target_biology', 'moa_pathway'] },
  { match: /#expression$/, sections: ['disease_indications', 'modality_developability'] },
  { match: /#tractability$/, sections: ['moa_pathway'] },
  { match: /#safety$/, sections: ['modality_developability'] },
];

function isCurated(source?: string): boolean {
  return source === 'Open Targets' || source === 'UniProt';
}

export function deriveStructuredClaims(store: EvidenceStore): Map<string, Claim[]> {
  const bySection = new Map<string, Claim[]>();
  let n = 0;
  for (const e of store.all()) {
    if (!isCurated(e.source)) continue;
    // `filter`, not `find`: a single match short-circuited multi-axis routing.
    const sections = ROUTES.filter((r) => r.match.test(e.id)).flatMap((r) => r.sections);
    if (!sections.length) continue;
    const text = (e.snippet ?? e.title ?? '').trim();
    if (!text) continue;
    n++;
    for (const section of sections) {
      const claim: Claim = {
        // Distinct per destination. Two sections carrying one claim id would
        // collide anywhere claims are keyed by id, and consolidation would
        // treat the second copy as a duplicate of the first and drop it.
        id: sections.length > 1 ? `struct-${n}-${section}` : `struct-${n}`,
        text: `${text} (${e.source})`,
        citations: [e.id],
        confidence: 0.9,
        // Asserted from the card, not verified by the verifier. Downstream gates
        // that count verified findings must be able to tell the difference.
        provenance: 'deterministic',
      };
      const list = bySection.get(section) ?? [];
      list.push(claim);
      bySection.set(section, list);
    }
  }
  return bySection;
}

/**
 * Prepend the derived structured claims to their target sections (leading,
 * high-confidence), then bring `sources` and `rag` back in step with what the
 * section actually ships.
 *
 * `rag` is computed in `produceResearchSection` before this merge runs, so
 * without recomputation it describes a claim set that is not the shipped one
 * and never sees the curated cards - the highest-confidence evidence present.
 * Mirrors `mergeGapClaims`, the other post-verification merge.
 */
export function mergeStructuredClaims(
  sections: Section[],
  store: EvidenceStore,
  resolveSourceIdentity: SourceIdentityResolver = createSourceIdentityResolver(store.all()),
): Section[] {
  const bySection = deriveStructuredClaims(store);
  if (bySection.size === 0) return sections;
  return sections.map((s) => {
    const add = bySection.get(s.id);
    if (!add || add.length === 0) return s;
    const existing = new Set(s.claims.map((c) => c.text));
    const fresh = add.filter((c) => !existing.has(c.text));
    if (fresh.length === 0) return s;
    const claims = [...fresh, ...s.claims];
    const sources = [...new Set([...s.sources, ...fresh.flatMap((c) => c.citations)])];
    const verdicts: Verdict[] = claims.map((c) => ({ claimId: c.id, status: 'supported', rationale: '' }));
    return { ...s, claims, sources, rag: computeRag(claims, verdicts, resolveSourceIdentity) };
  });
}
