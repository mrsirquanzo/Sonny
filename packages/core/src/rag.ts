import type { Claim, Verdict, RagRating } from '@sonny/shared';

export function computeRag(shipped: Claim[], verdicts: Verdict[]): RagRating {
  if (shipped.length === 0) return 'red';
  const statusOf = (id: string) => verdicts.find((v) => v.claimId === id)?.status;
  const supported = shipped.filter((c) => statusOf(c.id) === 'supported');
  if (supported.length === 0) return 'red';
  const distinctSources = new Set(supported.flatMap((c) => c.citations));
  const allSupported = shipped.every((c) => statusOf(c.id) === 'supported');
  if (allSupported && distinctSources.size >= 2) return 'green';
  return 'amber';
}
