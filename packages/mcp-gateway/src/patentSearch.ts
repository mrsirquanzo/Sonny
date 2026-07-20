import type { Evidence } from '@mrsirquanzo/sonny-shared';
import { asArray, getAccessToken, isoDate, text } from './epoPatent.js';
import type { Tool } from './tool.js';

const DEFAULT_BASE = 'https://ops.epo.org/3.2';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valuesAtKey(root: unknown, wanted: string): unknown[] {
  const found: unknown[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === wanted) found.push(child);
      visit(child);
    }
  };
  visit(root);
  return found;
}

function nodeText(node: unknown): string | undefined {
  const direct = text(node)?.trim();
  if (direct) return direct;
  if (!isObject(node)) return undefined;
  for (const key of ['name', 'text', 'value']) {
    const nested = text(node[key])?.trim();
    if (nested) return nested;
  }
  return undefined;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function documentIds(hit: unknown): JsonObject[] {
  if (!isObject(hit)) return [];
  const direct = asArray(hit['document-id'] ?? hit['ops:document-id']).filter(isObject);
  if (direct.length) return direct;
  return valuesAtKey(hit, 'document-id').flatMap((value) => asArray(value)).filter(isObject);
}

function preferredDocumentId(hit: unknown): JsonObject | undefined {
  const ids = documentIds(hit);
  const typeOf = (doc: JsonObject): string => String(doc['@document-id-type'] ?? '').toLowerCase();
  return ids.find((doc) => typeOf(doc) === 'docdb')
    ?? ids.find((doc) => typeOf(doc) === 'epodoc')
    ?? ids[0];
}

function patentIdentity(hit: unknown): { country: string; docNumber: string; kind?: string; date?: string } | undefined {
  const doc = preferredDocumentId(hit);
  if (!doc) return undefined;
  let country = nodeText(doc.country)?.toUpperCase().replace(/[^A-Z]/g, '') ?? '';
  let docNumber = nodeText(doc['doc-number'])?.toUpperCase().replace(/[^A-Z0-9]/g, '') ?? '';
  let kind = nodeText(doc.kind)?.toUpperCase().replace(/[^A-Z0-9]/g, '') || undefined;
  if (!country) {
    const combined = docNumber.match(/^([A-Z]{2})(.+)$/);
    if (combined) {
      country = combined[1];
      docNumber = combined[2];
    }
  }
  if (country && docNumber.startsWith(country)) docNumber = docNumber.slice(country.length);
  if (!kind) {
    const withKind = docNumber.match(/^(\d+)([A-Z]\d?)$/);
    if (withKind) {
      docNumber = withKind[1];
      kind = withKind[2];
    }
  }
  if (!country || !docNumber) return undefined;
  const rawDate = nodeText(doc.date)
    ?? valuesAtKey(hit, 'date').flatMap((value) => asArray(value)).map(nodeText).find(Boolean);
  const date = isoDate(rawDate) ?? (/^\d{4}-\d{2}-\d{2}$/.test(rawDate ?? '') ? rawDate : undefined);
  return { country, docNumber, kind, date };
}

function inventionTitle(hit: unknown): string | undefined {
  const nodes = [
    ...valuesAtKey(hit, 'invention-title'),
    ...valuesAtKey(hit, 'ops:invention-title'),
  ].flatMap((value) => asArray(value));
  const english = nodes.find((node) => isObject(node) && String(node['@lang'] ?? '').toLowerCase() === 'en');
  return nodeText(english) ?? nodes.map(nodeText).find(Boolean);
}

function applicants(hit: unknown): string[] {
  return unique([
    ...valuesAtKey(hit, 'applicant-name'),
    ...valuesAtKey(hit, 'ops:applicant-name'),
  ].flatMap((value) => asArray(value)).map(nodeText));
}

function classificationText(node: unknown): string | undefined {
  const direct = nodeText(node);
  if (direct) return direct.replace(/\s+/g, ' ');
  if (!isObject(node)) return undefined;
  const symbol = nodeText(node['classification-symbol']);
  if (symbol) return symbol.replace(/\s+/g, ' ');
  const components = ['section', 'class', 'subclass', 'main-group', 'subgroup']
    .map((key) => nodeText(node[key]))
    .filter((value): value is string => Boolean(value));
  return components.length ? components.join('') : undefined;
}

function ipcClasses(hit: unknown): string[] {
  return unique([
    ...valuesAtKey(hit, 'classification-symbol'),
    ...valuesAtKey(hit, 'patent-classification'),
    ...valuesAtKey(hit, 'classification-ipc'),
  ].flatMap((value) => asArray(value)).map(classificationText)).slice(0, 5);
}

function searchHits(json: unknown): unknown[] {
  const result = (json as JsonObject | undefined)?.['ops:world-patent-data'];
  const biblio = isObject(result) ? result['ops:biblio-search'] : undefined;
  const searchResult = isObject(biblio) ? biblio['ops:search-result'] : undefined;
  if (!isObject(searchResult)) return [];
  return asArray(searchResult['ops:publication-reference']);
}

function escapeCqlTerm(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export const patentSearchTool: Tool = {
  name: 'patent_search',
  description: 'Search EPO Espacenet (OPS) for patents relevant to a target/gene and return patent records (publication number, title, applicants, date) - a competitive/IP and freedom-to-operate signal.',
  async call(args, fetchImpl = fetch) {
    const q = String(args.symbol ?? args.query ?? args.target ?? args.gene ?? '').trim();
    if (!q) return [];

    const key = process.env.SONNY_EPO_KEY ?? '';
    const secret = process.env.SONNY_EPO_SECRET ?? '';
    if (!key || !secret) return [];

    const base = (process.env.SONNY_EPO_BASE ?? DEFAULT_BASE).replace(/\/$/, '');
    try {
      const token = await getAccessToken({ fetchImpl, key, secret, base, nowMs: Date.now() });
      if (!token) return [];

      const runSearch = async (cql: string): Promise<unknown[]> => {
        const url = `${base}/rest-services/published-data/search/biblio?q=${encodeURIComponent(cql)}&Range=1-10`;
        const response = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`EPO search HTTP ${response.status}`);
        return searchHits(await response.json());
      };

      const term = escapeCqlTerm(q);
      let hits = await runSearch(`ta="${term}" and (ta="antibody" or ta="conjugate")`);
      if (hits.length === 0) hits = await runSearch(`ta="${term}"`);

      const retrievedAt = new Date().toISOString();
      const evidence = new Map<string, Evidence>();
      for (const hit of hits) {
        const identity = patentIdentity(hit);
        if (!identity) continue;
        const publicationNumber = `${identity.country}${identity.docNumber}`;
        const id = `PATENT:${publicationNumber}${identity.kind ?? ''}`;
        if (evidence.has(id)) continue;
        const applicantNames = applicants(hit);
        const ipc = ipcClasses(hit);
        const snippet = [
          applicantNames.length ? applicantNames.join(', ') : undefined,
          identity.date,
          ipc.length ? `IPC ${ipc.join(', ')}` : undefined,
        ].filter((value): value is string => Boolean(value)).join(' · ');
        evidence.set(id, {
          id,
          kind: 'patent',
          source: 'EPO Espacenet (OPS)',
          title: inventionTitle(hit) ?? '(no title)',
          snippet,
          url: `https://worldwide.espacenet.com/patent/search?q=${encodeURIComponent(`pn=${publicationNumber}`)}`,
          raw: hit,
          retrievedAt,
        });
        if (evidence.size === 8) break;
      }
      return [...evidence.values()];
    } catch {
      return [];
    }
  },
};
