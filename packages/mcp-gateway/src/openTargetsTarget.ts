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
    safetyLiabilities { event effects { direction dosing } }
    subcellularLocations { location termSL }
    expressions { tissue { label organs } rna { value zscore level } protein { level } }
    associatedDiseases(page: { index: 0, size: 8 }) { rows { score disease { id name } } }
    drugAndClinicalCandidates { rows { maxClinicalStage drug { id name } } }
  }
}`;

async function gql(fetchImpl: typeof fetch, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const res = await fetchImpl(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  if (!res.ok) throw new Error(`Open Targets HTTP ${res.status}`);
  return res.json();
}

interface Tractability { modality: string; label: string; value: boolean }
interface Expression {
  tissue?: { label?: string; organs?: string[] };
  rna?: { value?: number; zscore?: number; level?: number };
  protein?: { level?: number };
}
interface TargetData {
  data?: { target?: {
    id: string; approvedSymbol: string; approvedName: string;
    symbolSynonyms?: Array<{ label: string }>;
    nameSynonyms?: Array<{ label: string }>;
    tractability?: Tractability[]; safetyLiabilities?: Array<{ event?: string }>;
    subcellularLocations?: Array<{ location?: string; termSL?: string }>;
    expressions?: Expression[];
    associatedDiseases?: { rows?: Array<{ score: number; disease: { id: string; name: string } }> };
    drugAndClinicalCandidates?: { rows?: Array<{ maxClinicalStage?: string | null; drug: { id: string; name: string } | null }> };
  } };
}

/** Antibody/ADC-relevant tractability buckets that are actually achieved (value=true). */
function antibodyTractability(tractability: Tractability[]): string[] {
  return tractability
    .filter((t) => t.value && /antibody|adc|cell.?surface|secreted|targetable/i.test(`${t.modality} ${t.label}`))
    .map((t) => `${t.modality}: ${t.label}`);
}

/**
 * Summarise baseline normal-tissue expression into the ADC therapeutic-window
 * signal: which non-tumour tissues express the target most highly (on-target /
 * off-tumour risk). Protein level is 0-3 (Human Protein Atlas scale); RNA level
 * is a normalised bin. We surface the highest-expressing normal tissues so a
 * specialist can judge selectivity honestly.
 */
function expressionSummary(expressions: Expression[]): { text: string; topTissues: Array<{ tissue: string; protein?: number; rna?: number }> } {
  const rows = expressions
    .map((e) => ({
      tissue: e.tissue?.label ?? 'unknown',
      protein: e.protein?.level,
      rna: e.rna?.level ?? (typeof e.rna?.value === 'number' ? e.rna.value : undefined),
    }))
    .filter((r) => r.tissue !== 'unknown');
  const ranked = [...rows].sort((a, b) => (b.protein ?? -1) - (a.protein ?? -1) || (b.rna ?? -1) - (a.rna ?? -1));
  const top = ranked.slice(0, 8);
  const highProtein = ranked.filter((r) => (r.protein ?? 0) >= 2).map((r) => r.tissue);
  const text = top.length
    ? `Baseline expression across ${rows.length} normal tissues. Highest-expressing normal tissues: ` +
      top.map((r) => `${r.tissue}${r.protein != null ? ` (protein ${r.protein}/3)` : ''}`).join(', ') +
      (highProtein.length ? `. Elevated normal-tissue protein (>=2/3), an ADC on-target/off-tumour consideration: ${highProtein.join(', ')}.` : '. No normal tissue shows high (>=2/3) protein expression.')
    : 'No baseline tissue-expression data available from Open Targets.';
  return { text, topTissues: top };
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
    const url = `https://platform.opentargets.org/target/${t.id}`;
    const tractability = t.tractability ?? [];
    const abTract = antibodyTractability(tractability);
    out.push({
      id: t.id, kind: 'target', source: 'Open Targets', title: `${t.approvedSymbol} — ${t.approvedName}`,
      snippet: `tractability: ${tractability.length} modalities; safety liabilities: ${(t.safetyLiabilities ?? []).length}`,
      url,
      raw: {
        tractability,
        safetyLiabilities: t.safetyLiabilities ?? [],
        approvedSymbol: t.approvedSymbol,
        synonyms: [...new Set([
          ...(t.symbolSynonyms ?? []).map((s) => s.label),
          ...(t.nameSynonyms ?? []).map((s) => s.label),
        ])],
      }, retrievedAt: now,
    });

    // Subcellular localisation - the cell-surface / membrane signal for antibody & ADC bindability.
    const locations = (t.subcellularLocations ?? []).map((l) => l.location ?? l.termSL).filter(Boolean) as string[];
    if (locations.length) {
      const surface = locations.some((l) => /cell membrane|plasma membrane|cell surface|extracellular/i.test(l));
      out.push({
        id: `${t.id}#localization`, kind: 'target', source: 'Open Targets',
        title: `${t.approvedSymbol} subcellular localisation`,
        snippet: `Subcellular location: ${[...new Set(locations)].join('; ')}.` +
          (surface ? ' Consistent with a cell-surface / membrane target accessible to an antibody or ADC.' : ' No clear cell-surface annotation - confirm bindability before an antibody/ADC approach.'),
        url, raw: { locations }, retrievedAt: now,
      });
    }

    // Baseline normal-tissue expression - the ADC tumour-vs-normal selectivity window.
    const expressions = t.expressions ?? [];
    if (expressions.length) {
      const summary = expressionSummary(expressions);
      out.push({
        id: `${t.id}#expression`, kind: 'target', source: 'Open Targets',
        title: `${t.approvedSymbol} baseline normal-tissue expression`,
        snippet: summary.text,
        url: `https://platform.opentargets.org/target/${t.id}?tab=expression`,
        raw: { topTissues: summary.topTissues, tissueCount: expressions.length }, retrievedAt: now,
      });
    }

    // Antibody/ADC tractability - is this target achievable by the intended modality?
    if (tractability.length) {
      out.push({
        id: `${t.id}#tractability`, kind: 'target', source: 'Open Targets',
        title: `${t.approvedSymbol} tractability (antibody / ADC)`,
        snippet: abTract.length
          ? `Antibody/ADC-relevant tractability buckets achieved: ${abTract.join('; ')}.`
          : 'No antibody/ADC tractability bucket is flagged as achieved - a developability risk for an antibody-based modality.',
        url: `${url}?tab=tractability`, raw: { tractability }, retrievedAt: now,
      });
    }

    // Known safety liabilities - developability / on-target-off-tumour risk.
    const safety = (t.safetyLiabilities ?? []).map((s) => s.event).filter(Boolean) as string[];
    if (safety.length) {
      out.push({
        id: `${t.id}#safety`, kind: 'target', source: 'Open Targets',
        title: `${t.approvedSymbol} known safety liabilities`,
        snippet: `Curated safety liabilities: ${[...new Set(safety)].join('; ')}.`,
        url: `${url}?tab=safety`, raw: { safetyLiabilities: t.safetyLiabilities }, retrievedAt: now,
      });
    }
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
