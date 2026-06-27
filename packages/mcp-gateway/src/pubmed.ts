import type { Evidence } from '@sonny/shared';
import type { Tool } from './tool.js';

const ESEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const ESUMMARY = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';

export const pubmedTool: Tool = {
  name: 'pubmed_search',
  description: 'Search PubMed and return publication records (PMID, title, source, year).',
  async call(args, fetchImpl = fetch) {
    const query = String(args.query ?? '').trim();
    if (!query) return [];
    const sres = await fetchImpl(`${ESEARCH}?db=pubmed&retmode=json&retmax=5&term=${encodeURIComponent(query)}`);
    if (!sres.ok) throw new Error(`PubMed esearch HTTP ${sres.status}`);
    const ids = (((await sres.json()) as { esearchresult?: { idlist?: string[] } }).esearchresult?.idlist) ?? [];
    if (ids.length === 0) return [];
    const ures = await fetchImpl(`${ESUMMARY}?db=pubmed&retmode=json&id=${ids.join(',')}`);
    if (!ures.ok) throw new Error(`PubMed esummary HTTP ${ures.status}`);
    const result = ((await ures.json()) as { result?: Record<string, { uid: string; title?: string; source?: string; pubdate?: string }> }).result ?? {};
    const now = new Date().toISOString();
    return ids.map<Evidence>((uid) => {
      const r = result[uid] ?? { uid };
      return {
        id: `PMID:${uid}`, kind: 'publication', source: 'PubMed', title: r.title ?? '(no title)',
        snippet: `${r.source ?? ''} ${r.pubdate ?? ''}`.trim(),
        url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`, raw: r, retrievedAt: now,
      };
    });
  },
};
