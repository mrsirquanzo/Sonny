import type { Claim, Section } from '@mrsirquanzo/sonny-shared';
import type { EvidenceStore } from './evidenceStore.js';

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
 * Routing (card id suffix -> section id):
 *   #localization, #domains  -> target_biology        (is it bindable on the surface?)
 *   #expression              -> disease_indications    (tumour-vs-normal selectivity window)
 *   #tractability, #safety   -> modality_developability(can it be drugged as an ADC, safely?)
 */
const ROUTES: Array<{ match: RegExp; section: string }> = [
  { match: /#localization$|#domains$/, section: 'target_biology' },
  { match: /#expression$/, section: 'disease_indications' },
  { match: /#tractability$|#safety$/, section: 'modality_developability' },
];

function isCurated(source?: string): boolean {
  return source === 'Open Targets' || source === 'UniProt';
}

export function deriveStructuredClaims(store: EvidenceStore): Map<string, Claim[]> {
  const bySection = new Map<string, Claim[]>();
  let n = 0;
  for (const e of store.all()) {
    if (!isCurated(e.source)) continue;
    const route = ROUTES.find((r) => r.match.test(e.id));
    if (!route) continue;
    const text = (e.snippet ?? e.title ?? '').trim();
    if (!text) continue;
    const claim: Claim = {
      id: `struct-${++n}`,
      text: `${text} (${e.source})`,
      citations: [e.id],
      confidence: 0.9,
    };
    const list = bySection.get(route.section) ?? [];
    list.push(claim);
    bySection.set(route.section, list);
  }
  return bySection;
}

/** Prepend the derived structured claims to their target sections (leading, high-confidence). */
export function mergeStructuredClaims(sections: Section[], store: EvidenceStore): Section[] {
  const bySection = deriveStructuredClaims(store);
  if (bySection.size === 0) return sections;
  return sections.map((s) => {
    const add = bySection.get(s.id);
    if (!add || add.length === 0) return s;
    const existing = new Set(s.claims.map((c) => c.text));
    const fresh = add.filter((c) => !existing.has(c.text));
    return { ...s, claims: [...fresh, ...s.claims] };
  });
}
