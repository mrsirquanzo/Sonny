import type { Evidence } from '@mrsirquanzo/sonny-shared';
import type { Tool } from './tool.js';

const SEARCH = 'https://rest.uniprot.org/uniprotkb/search';

interface UniProtComment {
  commentType?: string;
  subcellularLocations?: Array<{ location?: { value?: string }; topology?: { value?: string } }>;
  texts?: Array<{ value?: string }>;
}
interface UniProtFeature {
  type?: string;
  description?: string;
  location?: { start?: { value?: number }; end?: { value?: number } };
}
interface UniProtEntry {
  primaryAccession?: string;
  proteinDescription?: { recommendedName?: { fullName?: { value?: string } } };
  comments?: UniProtComment[];
  features?: UniProtFeature[];
}

/**
 * UniProt target annotation: subcellular localisation, transmembrane topology,
 * and domain architecture for the reviewed human protein of a gene symbol.
 *
 * This is the authoritative answer to the first ADC question - "is the target
 * actually on the cell surface?" - via curated subcellular-location and
 * transmembrane-region annotation, and it grounds the domain architecture an
 * antibody would bind. REST + reviewed(SwissProt) only, so it is citable.
 */
export const uniProtTargetTool: Tool = {
  name: 'uniprot_target',
  description: 'Fetch UniProt (reviewed/SwissProt) annotation for a human gene symbol: subcellular localisation, transmembrane topology, and domain architecture - the cell-surface bindability signal for an antibody or ADC.',
  async call(args, fetchImpl = fetch) {
    const symbol = String(args.symbol ?? args.query ?? args.target ?? args.gene ?? '').trim();
    if (!symbol) return [];
    const query = `gene_exact:${symbol} AND organism_id:9606 AND reviewed:true`;
    const fields = 'accession,protein_name,cc_subcellular_location,ft_transmem,ft_topo_dom,ft_domain';
    const params = new URLSearchParams({ query, fields, format: 'json', size: '1' });
    const res = await fetchImpl(`${SEARCH}?${params.toString()}`);
    if (!res.ok) throw new Error(`UniProt HTTP ${res.status}`);
    const body = (await res.json()) as { results?: UniProtEntry[] };
    const entry = body.results?.[0];
    if (!entry?.primaryAccession) return [];

    const acc = entry.primaryAccession;
    const url = `https://www.uniprot.org/uniprotkb/${acc}/entry`;
    const now = new Date().toISOString();
    const name = entry.proteinDescription?.recommendedName?.fullName?.value ?? symbol;
    const out: Evidence[] = [];

    const locComment = (entry.comments ?? []).find((c) => c.commentType === 'SUBCELLULAR LOCATION');
    const locations = (locComment?.subcellularLocations ?? [])
      .map((l) => l.location?.value)
      .filter((v): v is string => Boolean(v));
    const topology = (locComment?.subcellularLocations ?? [])
      .map((l) => l.topology?.value)
      .filter((v): v is string => Boolean(v));
    const transmem = (entry.features ?? []).filter((f) => f.type === 'Transmembrane');
    const topoDom = (entry.features ?? []).filter((f) => f.type === 'Topological domain');
    const extracellular = topoDom.some((f) => /extracellular/i.test(f.description ?? ''));
    const surface = extracellular || transmem.length > 0 ||
      locations.some((l) => /cell membrane|plasma membrane|cell surface|extracellular/i.test(l));

    if (locations.length || transmem.length) {
      out.push({
        id: `UNIPROT:${acc}#localization`, kind: 'target', source: 'UniProt',
        title: `${symbol} (${name}) localisation & topology`,
        snippet:
          (locations.length ? `Subcellular location: ${[...new Set(locations)].join('; ')}. ` : '') +
          (transmem.length ? `${transmem.length} transmembrane region(s)${extracellular ? ' with an extracellular domain' : ''}. ` : '') +
          (surface
            ? 'The extracellular/transmembrane topology supports an antibody- or ADC-accessible cell-surface epitope.'
            : 'No transmembrane or extracellular topology annotated - confirm surface accessibility before an antibody/ADC approach.'),
        url,
        raw: { accession: acc, locations, topology, transmembraneCount: transmem.length, hasExtracellularDomain: extracellular },
        retrievedAt: now,
      });
    }

    const domains = (entry.features ?? [])
      .filter((f) => f.type === 'Domain' && f.description)
      .map((f) => f.description as string);
    if (domains.length) {
      out.push({
        id: `UNIPROT:${acc}#domains`, kind: 'target', source: 'UniProt',
        title: `${symbol} domain architecture`,
        snippet: `Annotated domains: ${[...new Set(domains)].join('; ')}.`,
        url, raw: { accession: acc, domains }, retrievedAt: now,
      });
    }

    return out;
  },
};
