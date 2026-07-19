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
    subcellularLocations { location termSL }
    baselineExpression { rows { median specificity_score datatypeId tissueBiosample { biosampleName } } }
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
interface BaselineRow {
  median?: number | null;
  specificity_score?: number | null;
  datatypeId?: string | null;
  tissueBiosample?: { biosampleName?: string | null } | null;
}
interface TargetData {
  data?: { target?: {
    id: string; approvedSymbol: string; approvedName: string;
    symbolSynonyms?: Array<{ label: string }>;
    nameSynonyms?: Array<{ label: string }>;
    tractability?: Tractability[]; safetyLiabilities?: Array<{ event?: string }>;
    subcellularLocations?: Array<{ location?: string; termSL?: string }>;
    baselineExpression?: { rows?: BaselineRow[] };
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
 * Summarise Open Targets baseline expression into the ADC therapeutic-window
 * signal: which normal tissues express the target most highly (on-target /
 * off-tumour risk). `median` is the datatype's expression unit (TPM for RNA,
 * intensity for proteomics); `specificity_score` (0-1) flags how tissue-restricted
 * expression is - a higher score across few tissues is a friendlier ADC window.
 */
function expressionSummary(rows: BaselineRow[]): { text: string; topTissues: Array<{ tissue: string; median: number; datatype?: string }> } {
  const clean = rows
    .filter((r) => typeof r.median === 'number' && r.tissueBiosample?.biosampleName)
    .map((r) => ({ tissue: r.tissueBiosample!.biosampleName as string, median: r.median as number, datatype: r.datatypeId ?? undefined }));
  const ranked = [...clean].sort((a, b) => b.median - a.median);
  const top = ranked.slice(0, 8);
  const proteinTop = ranked.filter((r) => /proteomics|protein/i.test(r.datatype ?? '')).slice(0, 5).map((r) => r.tissue);
  const text = top.length
    ? `Baseline expression across ${clean.length} normal biosamples (Open Targets: GTEx/HPA/single-cell). Highest-expressing normal tissues: ` +
      top.map((r) => `${r.tissue} (${r.median.toFixed(0)}${r.datatype ? `, ${r.datatype}` : ''})`).join('; ') + '.' +
      (proteinTop.length ? ` Normal tissues with notable protein-level expression, an ADC on-target/off-tumour consideration: ${proteinTop.join(', ')}.` : '')
    : 'No baseline tissue-expression data available from Open Targets.';
  return { text, topTissues: top };
}

export const openTargetsTargetTool: Tool = {
  name: 'open_targets_target',
  description: 'Fetch the Open Targets target dossier for a gene symbol: associations (scored), tractability, known drugs, safety liabilities.',
  async call(args, fetchImpl = fetch) {
    const symbol = String(args.symbol ?? args.query ?? args.target ?? args.gene ?? '').trim();
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
    const expressions = t.baselineExpression?.rows ?? [];
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
