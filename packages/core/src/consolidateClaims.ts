import type { Claim, Section } from '@mrsirquanzo/sonny-shared';

/**
 * Cross-section claim consolidation.
 *
 * Specialists run in parallel over one shared evidence store, so they
 * independently surface the same facts - the dossier ends up restating
 * "Trop-2 is overexpressed..." in five sections. This pass runs after the
 * specialists finish and collapses duplicate facts across the whole dossier so
 * each section carries new information rather than a repeated claim.
 *
 * Two claims describe the same fact when their normalized text matches, OR when
 * they cite the exact same evidence set and their wording overlaps
 * substantially (catches reworded restatements of one source's finding). The
 * best-supported version is kept and the group's citations are unioned onto it,
 * so no source is lost.
 */

function normKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function citeKey(citations: string[]): string {
  return [...citations].sort().join('|');
}

const TEXT_OVERLAP_THRESHOLD = 0.5;

interface Located {
  si: number;
  ci: number;
  claim: Claim;
  toks: Set<string>;
}

function sameFact(a: Located, b: Located): boolean {
  if (normKey(a.claim.text) === normKey(b.claim.text)) return true;
  const ca = citeKey(a.claim.citations);
  const cb = citeKey(b.claim.citations);
  if (ca !== '' && ca === cb && jaccard(a.toks, b.toks) >= TEXT_OVERLAP_THRESHOLD) return true;
  return false;
}

export function consolidateSectionClaims(sections: Section[]): { sections: Section[]; merged: number } {
  const located: Located[] = [];
  sections.forEach((s, si) =>
    (s.claims ?? []).forEach((claim, ci) => located.push({ si, ci, claim, toks: tokens(claim.text) })),
  );

  // Greedy grouping - n is small (tens of claims), O(n^2) is fine.
  const groups: Located[][] = [];
  for (const item of located) {
    const group = groups.find((g) => g.some((m) => sameFact(m, item)));
    if (group) group.push(item);
    else groups.push([item]);
  }

  const removeLoc = new Set<string>();
  const citeOverride = new Map<string, string[]>();
  let merged = 0;

  for (const group of groups) {
    if (group.length === 1) continue;
    // Representative: most citations, then highest confidence, then most complete
    // text, then earliest section (stable, keeps the fact near the top).
    const repr = group.slice().sort((x, y) =>
      (y.claim.citations.length - x.claim.citations.length) ||
      (y.claim.confidence - x.claim.confidence) ||
      (y.claim.text.length - x.claim.text.length) ||
      (x.si - y.si) ||
      (x.ci - y.ci),
    )[0];
    const unioned = [...new Set(group.flatMap((m) => m.claim.citations))];
    citeOverride.set(`${repr.si}:${repr.ci}`, unioned);
    for (const m of group) {
      if (m === repr) continue;
      removeLoc.add(`${m.si}:${m.ci}`);
      merged += 1;
    }
  }

  if (merged === 0) return { sections, merged: 0 };

  const newSections = sections.map((s, si) => {
    const claims = (s.claims ?? [])
      .map((claim, ci) => {
        const loc = `${si}:${ci}`;
        if (removeLoc.has(loc)) return null;
        const override = citeOverride.get(loc);
        return override ? { ...claim, citations: override } : claim;
      })
      .filter((c): c is Claim => c !== null);
    return { ...s, claims };
  });

  return { sections: newSections, merged };
}
