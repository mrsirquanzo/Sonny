import type { Claim, Evidence, Verdict, RagRating } from '@mrsirquanzo/sonny-shared';

export type SourceIdentityResolver = (evidenceId: string) => string;

function publicationRoot(id: string): string {
  return id.split('#', 1)[0];
}

/**
 * Resolve citation tokens to independent sources: parent publications for
 * literature passages/figures and logical dataset releases for computations.
 */
export function createSourceIdentityResolver(evidence: readonly Evidence[]): SourceIdentityResolver {
  const byId = new Map(evidence.map((item) => [item.id, item]));
  const pmcidParents = new Map<string, string>();
  for (const item of evidence) {
    if (item.kind !== 'publication' || !item.id.startsWith('PMID:')) continue;
    const pmcid = (item.raw as { pmcid?: unknown } | null)?.pmcid;
    if (typeof pmcid === 'string' && pmcid.length > 0) {
      pmcidParents.set(`PMCID:${pmcid.replace(/^PMCID:/, '')}`, item.id);
    }
  }
  return (evidenceId) => {
    const item = byId.get(evidenceId);
    if (!item) return publicationRoot(evidenceId);
    if (item.kind === 'computation') {
      const releases = [...new Set(item.datasetInputs.map((dataset) => dataset.logicalSourceId))].sort();
      return `dataset-release:${releases.join('+')}`;
    }
    if (item.kind === 'publication' || item.kind === 'figure') {
      const root = publicationRoot(item.id);
      return pmcidParents.get(root) ?? root;
    }
    return item.id;
  };
}

export function computeRag(
  shipped: Claim[],
  verdicts: Verdict[],
  resolveSourceIdentity: SourceIdentityResolver,
): RagRating {
  if (shipped.length === 0) return 'red';
  const statusOf = (id: string) => verdicts.find((v) => v.claimId === id)?.status;
  const supported = shipped.filter((c) => statusOf(c.id) === 'supported');
  if (supported.length === 0) return 'red';
  const distinctSources = new Set(supported.flatMap((c) => c.citations.map(resolveSourceIdentity)));
  const allSupported = shipped.every((c) => statusOf(c.id) === 'supported');
  if (allSupported && distinctSources.size >= 2) return 'green';
  return 'amber';
}
