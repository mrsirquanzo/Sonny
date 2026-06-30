import type { Evidence } from '@sonny/shared';
import type { Tool } from './tool.js';

const BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest';

interface Citer { id?: string; source?: string; title?: string; citedByCount?: number; pubYear?: string }

export const europePmcCitationsTool: Tool = {
  name: 'europepmc_citations',
  description: 'Fetch the papers that cite a given PMID (forward citations), ranked by citation count, for snowball expansion. Returns title-only evidence; hydrate via europepmc_search EXT_ID for abstracts.',
  async call(args, fetchImpl = fetch) {
    const pmid = String(args.pmid ?? '').trim();
    if (!pmid) return [];
    const url = `${BASE}/MED/${encodeURIComponent(pmid)}/citations?format=json&pageSize=8&sort=${encodeURIComponent('CITED desc')}`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Europe PMC citations HTTP ${res.status}`);
    const list = (((await res.json()) as { citationList?: { citation?: Citer[] } }).citationList?.citation) ?? [];
    const now = new Date().toISOString();
    return list
      .filter((c) => c.id && c.source === 'MED')
      .map<Evidence>((c) => ({
        id: `PMID:${c.id}`, kind: 'publication', source: 'Europe PMC',
        title: c.title ?? '(no title)',
        snippet: `cited ${c.citedByCount ?? 0}x . ${c.pubYear ?? ''}`.trim(),
        passage: '',
        url: `https://europepmc.org/article/MED/${c.id}`,
        raw: { citedByCount: Number(c.citedByCount ?? 0), pubYear: c.pubYear ?? '' },
        retrievedAt: now,
      }));
  },
};
