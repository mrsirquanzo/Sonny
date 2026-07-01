import type { Evidence } from '@mrsirquanzo/sonny-shared';
import type { Tool } from './tool.js';

const ENDPOINT = 'https://api.platform.opentargets.org/api/v4/graphql';
const QUERY = `query Search($q: String!) {
  search(queryString: $q, entityNames: ["target"]) {
    hits { id name entity description }
  }
}`;

export const openTargetsTool: Tool = {
  name: 'open_targets_search',
  description: 'Resolve a gene symbol to its Open Targets target record (ENSG id, name, description).',
  async call(args, fetchImpl = fetch) {
    const symbol = String(args.symbol ?? '').trim();
    if (!symbol) return [];
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { q: symbol } }),
    });
    if (!res.ok) throw new Error(`Open Targets HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { search?: { hits?: Array<{ id: string; name: string; entity: string; description?: string }> } } };
    const hits = (json.data?.search?.hits ?? []).filter((h) => h.entity === 'target' && h.id.startsWith('ENSG'));
    const now = new Date().toISOString();
    return hits.slice(0, 1).map<Evidence>((h) => ({
      id: h.id, kind: 'target', source: 'Open Targets', title: h.name,
      snippet: h.description ?? '', url: `https://platform.opentargets.org/target/${h.id}`, raw: h, retrievedAt: now,
    }));
  },
};
