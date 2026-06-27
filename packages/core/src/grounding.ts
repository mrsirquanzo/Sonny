import type { Claim } from '@sonny/shared';
import type { EvidenceStore } from './evidenceStore.js';

export function groundClaims(
  claims: Claim[],
  store: EvidenceStore,
): { shippable: Claim[]; stripped: Array<{ claim: Claim; reason: string }> } {
  const shippable: Claim[] = [];
  const stripped: Array<{ claim: Claim; reason: string }> = [];
  for (const c of claims) {
    if (c.citations.length === 0) { stripped.push({ claim: c, reason: 'no citation' }); continue; }
    const unresolved = c.citations.filter((id) => !store.has(id));
    if (unresolved.length > 0) { stripped.push({ claim: c, reason: `citation does not resolve: ${unresolved.join(', ')}` }); continue; }
    shippable.push(c);
  }
  return { shippable, stripped };
}
