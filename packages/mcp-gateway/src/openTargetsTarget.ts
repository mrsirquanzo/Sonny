import type { Evidence } from '@mrsirquanzo/sonny-shared';
import type { Tool } from './tool.js';

const ENDPOINT = 'https://api.platform.opentargets.org/api/v4/graphql';
const SEARCH = `query Resolve($q: String!) { search(queryString: $q, entityNames: ["target"]) { hits { id entity } } }`;
const TARGET = `query Target($id: String!) {
  target(ensemblId: $id) {
    id approvedSymbol approvedName
    symbolSynonyms { label }
    nameSynonyms { label }
    tractability { modality label value }
    safetyLiabilities { event }
    associatedDiseases(page: { index: 0, size: 8 }) { rows { score disease { id name } } }
    drugAndClinicalCandidates { rows { maxClinicalStage drug { id name } } }
  }
}`;

async function gql(fetchImpl: typeof fetch, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const res = await fetchImpl(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  if (!res.ok) throw new Error(`Open Targets HTTP ${res.status}`);
  return res.json();
}

interface TargetData {
  data?: { target?: {
    id: string; approvedSymbol: string; approvedName: string;
    symbolSynonyms?: Array<{ label: string }>;
    nameSynonyms?: Array<{ label: string }>;
    tractability?: unknown[]; safetyLiabilities?: unknown[];
    associatedDiseases?: { rows?: Array<{ score: number; disease: { id: string; name: string } }> };
    drugAndClinicalCandidates?: { rows?: Array<{ maxClinicalStage?: string | null; drug: { id: string; name: string } | null }> };
  } };
}

export const openTargetsTargetTool: Tool = {
  name: 'open_targets_target',
  description: 'Fetch the Open Targets target dossier for a gene symbol: associations (scored), tractability, known drugs, safety liabilities.',
  async call(args, fetchImpl = fetch) {
    const symbol = String(args.symbol ?? '').trim();
    if (!symbol) return [];
    const search = (await gql(fetchImpl, SEARCH, { q: symbol })) as { data?: { search?: { hits?: Array<{ id: string; entity: string }> } } };
    const ensg = (search.data?.search?.hits ?? []).find((h) => h.entity === 'target' && h.id.startsWith('ENSG'))?.id;
    if (!ensg) return [];
    const t = ((await gql(fetchImpl, TARGET, { id: ensg })) as TargetData).data?.target;
    if (!t) return [];
    const now = new Date().toISOString();
    const out: Evidence[] = [];
    out.push({
      id: t.id, kind: 'target', source: 'Open Targets', title: `${t.approvedSymbol} — ${t.approvedName}`,
      snippet: `tractability: ${(t.tractability ?? []).length} modalities; safety liabilities: ${(t.safetyLiabilities ?? []).length}`,
      url: `https://platform.opentargets.org/target/${t.id}`,
      raw: {
        tractability: t.tractability ?? [],
        safetyLiabilities: t.safetyLiabilities ?? [],
        approvedSymbol: t.approvedSymbol,
        synonyms: [...new Set([
          ...(t.symbolSynonyms ?? []).map((s) => s.label),
          ...(t.nameSynonyms ?? []).map((s) => s.label),
        ])],
      }, retrievedAt: now,
    });
    for (const r of t.associatedDiseases?.rows ?? []) {
      out.push({ id: r.disease.id, kind: 'disease', source: 'Open Targets',
        title: r.disease.name, snippet: `association score ${r.score.toFixed(2)} for ${t.approvedSymbol}`,
        url: `https://platform.opentargets.org/evidence/${t.id}/${r.disease.id}`, raw: r, retrievedAt: now });
    }
    for (const r of t.drugAndClinicalCandidates?.rows ?? []) {
      if (!r.drug) continue;
      out.push({ id: r.drug.id, kind: 'drug', source: 'Open Targets',
        title: r.drug.name, snippet: `clinical candidate for ${t.approvedSymbol}${r.maxClinicalStage ? ` — max clinical stage ${r.maxClinicalStage}` : ''}`,
        url: `https://platform.opentargets.org/drug/${r.drug.id}`, raw: r, retrievedAt: now });
    }
    return out;
  },
};
