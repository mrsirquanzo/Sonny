// Assemble a broad two-term Europe PMC query: the target plus one concept facet.
// The target is always pinned; the concept is phrase-quoted when multi-word so
// Europe PMC treats it as one phrase rather than ANDing each word.
export function buildSearchQuery(target: string, concept: string): string {
  const c = concept.trim();
  if (!c) return target;
  return /\s/.test(c) ? `${target} AND "${c}"` : `${target} AND ${c}`;
}
