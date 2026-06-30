// Assemble a broad two-term Europe PMC query: the target plus one concept facet.
// The target is pinned to the TITLE_ABS field so Europe PMC returns papers where the
// target is a subject (in title or abstract), not papers that merely cite it in full
// text. The concept stays free text and is phrase-quoted when multi-word.
export function buildSearchQuery(target: string, concept: string): string {
  const c = concept.trim();
  const pinned = `TITLE_ABS:${target}`;
  if (!c) return pinned;
  return /\s/.test(c) ? `${pinned} AND "${c}"` : `${pinned} AND ${c}`;
}
