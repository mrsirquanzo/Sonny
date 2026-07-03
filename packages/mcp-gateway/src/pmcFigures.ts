import { XMLParser } from 'fast-xml-parser';
import type { Evidence } from '@mrsirquanzo/sonny-shared';
import type { Tool } from './tool.js';

const EFETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';
// Attributes ON so we can read graphic xlink:href (the figure image ref).
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' });

function textOf(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'object') {
    // Skip attribute keys (prefixed @_) when flattening to text.
    return Object.entries(node as Record<string, unknown>)
      .filter(([k]) => !k.startsWith('@_'))
      .map(([, v]) => textOf(v)).join(' ');
  }
  return '';
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

function collectFigs(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (node == null || typeof node !== 'object') return out;
  const n = node as Record<string, unknown>;
  for (const fig of asArray(n.fig as unknown)) out.push(fig as Record<string, unknown>);
  for (const [k, v] of Object.entries(n)) {
    if (k === 'fig' || k.startsWith('@_')) continue;
    if (Array.isArray(v)) v.forEach((c) => collectFigs(c, out));
    else if (typeof v === 'object') collectFigs(v, out);
  }
  return out;
}

function graphicHref(fig: Record<string, unknown>): string | undefined {
  const g = fig.graphic as Record<string, unknown> | Record<string, unknown>[] | undefined;
  const first = Array.isArray(g) ? g[0] : g;
  const href = first?.['@_xlink:href'] ?? first?.['@_href'];
  return href == null ? undefined : String(href);
}

export const pmcFiguresTool: Tool = {
  name: 'pmc_figures',
  description: 'Fetch an open-access PMC article\'s figures (by PMC id) and register each as caption-anchored Evidence (kind: figure).',
  async call(args, fetchImpl = fetch) {
    const pmcid = String(args.pmcid ?? '').trim();
    if (!pmcid) return [];
    const numeric = pmcid.replace(/^PMC/i, '');
    const res = await fetchImpl(`${EFETCH}?db=pmc&id=${encodeURIComponent(numeric)}&rettype=full&retmode=xml`);
    if (!res.ok) throw new Error(`PMC efetch HTTP ${res.status}`);
    const doc = parser.parse(await res.text()) as Record<string, unknown>;
    const set = (doc['pmc-articleset'] ?? doc) as Record<string, unknown>;
    const articleRaw = set.article ?? set;
    const article = (Array.isArray(articleRaw) ? articleRaw[0] : articleRaw) as Record<string, unknown>;
    const figs = collectFigs(article.body ?? article);
    const now = new Date().toISOString();
    const out: Evidence[] = [];
    figs.forEach((fig, i) => {
      const caption = textOf(fig.caption).replace(/\s+/g, ' ').trim();
      if (!caption) return; // no caption = no grounding anchor, skip
      const label = textOf(fig.label).trim() || `Figure ${i + 1}`;
      const href = graphicHref(fig);
      out.push({
        id: `PMCID:${pmcid}#fig-${i}`, kind: 'figure', source: 'pmc',
        title: label, snippet: caption.slice(0, 200), passage: caption, locator: `fig-${i}`,
        url: href
          ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/bin/${href}`
          : `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/`,
        raw: fig, retrievedAt: now,
        metadata: href ? { imageRef: href } : undefined,
      });
    });
    return out;
  },
};
