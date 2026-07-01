import type { Claim, Verdict } from '@mrsirquanzo/sonny-shared';

export function recallAtK(retrievedIds: string[], expectedIds: string[]): number {
  if (expectedIds.length === 0) return 1;
  const found = expectedIds.filter((id) => retrievedIds.includes(id)).length;
  return found / expectedIds.length;
}

export function faithfulness(shipped: Claim[], verdicts: Verdict[]): number {
  if (shipped.length === 0) return 1;
  const supported = shipped.filter((c) => verdicts.find((v) => v.claimId === c.id)?.status === 'supported').length;
  return supported / shipped.length;
}
