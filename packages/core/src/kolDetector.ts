import { KOLClusterSchema, type KOLCluster } from '@sonny/shared';
import type { EvidenceStore } from './evidenceStore.js';

const FULLTEXT_WEIGHT = 3;
const ABSTRACT_WEIGHT = 1;

function mode(xs: string[]): string {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

// Pure aggregation over the store: the last author is the PI; a paper Sonny deep-read
// (its pmcid has full-text sections in the store) is a seminal paper and weighs more
// than an abstract-only hit. Every lab is grounded in the evidence ids it came from.
export function mapSpecialtyLabs(store: EvidenceStore, target: string): KOLCluster {
  const all = store.all();
  const fullTextPmcids = new Set<string>();
  for (const e of all) {
    if (e.id.startsWith('PMCID:')) {
      const pmcid = (e.raw as { pmcid?: string })?.pmcid;
      if (pmcid) fullTextPmcids.add(pmcid);
    }
  }

  type Agg = { weight: number; paperCount: number; evidenceIds: string[]; affiliations: string[] };
  const byPI = new Map<string, Agg>();

  for (const e of all) {
    const authors = e.metadata?.authors;
    if (!authors || !authors.length) continue;
    const last = authors[authors.length - 1];
    const pmcid = (e.raw as { pmcid?: string })?.pmcid ?? '';
    const w = pmcid && fullTextPmcids.has(pmcid) ? FULLTEXT_WEIGHT : ABSTRACT_WEIGHT;
    const agg = byPI.get(last.name) ?? { weight: 0, paperCount: 0, evidenceIds: [], affiliations: [] };
    agg.weight += w;
    agg.paperCount += 1;
    agg.evidenceIds.push(e.id);
    if (last.affiliation) agg.affiliations.push(last.affiliation);
    byPI.set(last.name, agg);
  }

  const labs = [...byPI.entries()]
    .map(([investigator, a]) => ({
      investigator,
      ...(a.affiliations.length ? { institution: mode(a.affiliations) } : {}),
      paperCount: a.paperCount,
      weight: a.weight,
      evidenceIds: a.evidenceIds,
    }))
    .sort((x, y) => y.weight - x.weight || y.paperCount - x.paperCount || x.investigator.localeCompare(y.investigator))
    .slice(0, 3);

  return KOLClusterSchema.parse({ target, labs });
}
