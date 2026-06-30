import type { Evidence, EvidenceMetadata } from '@sonny/shared';
import type { Tool } from './tool.js';

const ENDPOINT = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';

interface Hit {
  id: string; source: string; pmid?: string; pmcid?: string;
  title?: string; abstractText?: string; citedByCount?: string;
  isOpenAccess?: string; firstPublicationDate?: string;
  pubTypeList?: { pubType?: string[] };
  authorList?: { author?: Array<{
    fullName?: string;
    authorId?: { type?: string; value?: string };
    authorAffiliationDetailsList?: { authorAffiliation?: Array<{ affiliation?: string }> };
  }> };
}

function parseMetadata(h: Hit): EvidenceMetadata | undefined {
  const list = h.authorList?.author ?? [];
  if (!list.length) return undefined;
  const authors = list.map((a) => {
    const affiliation = a.authorAffiliationDetailsList?.authorAffiliation?.[0]?.affiliation;
    const orcid = a.authorId?.type === 'ORCID' ? a.authorId.value : undefined;
    return { name: a.fullName ?? '(unknown)', ...(affiliation ? { affiliation } : {}), ...(orcid ? { orcid } : {}) };
  });
  const institutions = [...new Set(authors.map((a) => a.affiliation).filter((x): x is string => !!x))];
  return { authors, ...(institutions.length ? { institutions } : {}) };
}

export const europePmcSearchTool: Tool = {
  name: 'europepmc_search',
  description: 'Search Europe PMC for publications, ranked by citation count. Returns title, abstract, citation count, review flag, and PMC id for full-text retrieval.',
  async call(args, fetchImpl = fetch) {
    const query = String(args.query ?? '').trim();
    if (!query) return [];
    const url = `${ENDPOINT}?query=${encodeURIComponent(query)}&format=json&resultType=core&pageSize=8&sort=${encodeURIComponent('CITED desc')}`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Europe PMC HTTP ${res.status}`);
    const hits = (((await res.json()) as { resultList?: { result?: Hit[] } }).resultList?.result) ?? [];
    const now = new Date().toISOString();
    return hits
      .filter((h) => h.pmid)
      .map<Evidence>((h) => {
        const types = h.pubTypeList?.pubType ?? [];
        const isReview = types.some((t) => /review/i.test(t));
        const metadata = parseMetadata(h);
        return {
          id: `PMID:${h.pmid}`, kind: 'publication', source: 'Europe PMC',
          title: h.title ?? '(no title)',
          snippet: `cited ${h.citedByCount ?? '0'}x . ${h.firstPublicationDate ?? ''}`.trim(),
          passage: h.abstractText ?? '',
          url: `https://europepmc.org/article/${h.source}/${h.pmid}`,
          raw: { pmcid: h.pmcid ?? '', citedByCount: Number(h.citedByCount ?? 0), isReview, isOpenAccess: h.isOpenAccess === 'Y' },
          retrievedAt: now,
          ...(metadata ? { metadata } : {}),
        };
      });
  },
};
