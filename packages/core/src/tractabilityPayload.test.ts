import { describe, expect, it } from 'vitest';
import { openTargetsTargetTool } from '../../mcp-gateway/src/openTargetsTarget.js';

const buckets = [
  { modality: 'SM', label: 'Approved Drug', value: true },
  { modality: 'SM', label: 'High-Quality Ligand', value: false },
  { modality: 'AB', label: 'Clinical Precedence', value: true },
  { modality: 'PR', label: 'Predicted Tractable', value: true },
];

const fakeFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
  const request = JSON.parse(String(init?.body)) as { variables?: { q?: string } };
  const body = request.variables?.q
    ? { data: { search: { hits: [{ id: 'ENSG_KRAS', entity: 'target' }] } } }
    : { data: { target: {
      id: 'ENSG_KRAS', approvedSymbol: 'KRAS', approvedName: 'KRAS proto-oncogene',
      tractability: buckets, safetyLiabilities: [],
    } } };
  return new Response(JSON.stringify(body), { status: 200 });
}) as unknown as typeof fetch;

describe('Open Targets tractability payload', () => {
  it('exposes every returned bucket, including non-antibody and false-valued buckets', async () => {
    const out = await openTargetsTargetTool.call({ symbol: 'KRAS' }, fakeFetch);
    const card = out.find((item) => item.id.endsWith('#tractability'));
    expect(card).toBeDefined();

    const emitted = (card?.raw as { tractability: typeof buckets }).tractability;
    expect(emitted).toEqual(buckets);
    expect(emitted).toHaveLength(buckets.length);
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({ modality: 'SM', label: 'Approved Drug', value: true }),
      expect.objectContaining({ modality: 'AB', label: 'Clinical Precedence', value: true }),
      expect.objectContaining({ modality: 'PR', label: 'Predicted Tractable', value: true }),
      expect.objectContaining({ modality: 'SM', label: 'High-Quality Ligand', value: false }),
    ]));

    // The card shown to routers/models must expose the bucket facts, not merely
    // retain them in an opaque parent record.
    for (const bucket of buckets) {
      expect(`${card?.title}\n${card?.snippet}`).toContain(bucket.modality);
      expect(`${card?.title}\n${card?.snippet}`).toContain(bucket.label);
    }
  });
});
