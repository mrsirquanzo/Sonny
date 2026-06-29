import { XMLParser } from 'fast-xml-parser';
import type { Evidence } from '@sonny/shared';
import type { Tool } from './tool.js';

const EFETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';
const parser = new XMLParser({ ignoreAttributes: true, textNodeName: '#text' });

// Flatten any nested node into plain text, joining all string fragments in order.
function textOf(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'object') return Object.values(node as Record<string, unknown>).map(textOf).join(' ');
  return '';
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

function collectSecs(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  for (const sec of asArray((node as Record<string, unknown> | undefined)?.sec as unknown)) {
    const s = sec as Record<string, unknown>;
    out.push(s);
    collectSecs(s, out);
  }
  return out;
}

export const pmcFullTextTool: Tool = {
  name: 'pmc_fulltext',
  description: 'Fetch the full text of an open-access PMC article (by PMC id) and return its body sections as passages for grounding.',
  async call(args, fetchImpl = fetch) {
    const pmcid = String(args.pmcid ?? '').trim();
    if (!pmcid) return [];
    const numeric = pmcid.replace(/^PMC/i, '');
    const res = await fetchImpl(`${EFETCH}?db=pmc&id=${encodeURIComponent(numeric)}&rettype=full&retmode=xml`);
    if (!res.ok) throw new Error(`PMC efetch HTTP ${res.status}`);
    const xml = await res.text();
    const doc = parser.parse(xml) as Record<string, unknown>;
    const set = ((doc as Record<string, unknown>)['pmc-articleset'] ?? doc) as Record<string, unknown>;
    const articleRaw = set.article ?? set;
    const article = (Array.isArray(articleRaw) ? articleRaw[0] : articleRaw) as Record<string, unknown>;
    const body = (article.body ?? {}) as Record<string, unknown>;
    const allSecs = collectSecs(body);
    const now = new Date().toISOString();
    const out: Evidence[] = [];
    let emitIdx = 0;
    for (const s of allSecs) {
      const passage = asArray(s.p as unknown).map(textOf).join(' ').replace(/\s+/g, ' ').trim();
      if (!passage) continue;
      const title = textOf(s.title).trim() || `Section ${emitIdx + 1}`;
      out.push({
        id: `PMCID:${pmcid}#sec-${emitIdx}`, kind: 'publication', source: 'PMC full text',
        title, snippet: title, passage, locator: title,
        url: `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/`,
        raw: { pmcid, sectionIndex: emitIdx }, retrievedAt: now,
      });
      emitIdx++;
    }
    return out;
  },
};
