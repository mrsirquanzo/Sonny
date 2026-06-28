import { describe, it, expect } from 'vitest';
import { openTargetsTargetTool } from './openTargetsTarget.js';

const payload = {
  data: { target: {
    id: 'ENSG00000163814', approvedSymbol: 'CDCP1', approvedName: 'CUB domain containing protein 1',
    tractability: [{ modality: 'SM', label: 'Approved Drug', value: false }],
    safetyLiabilities: [{ event: 'cardiotoxicity' }],
    associatedDiseases: { rows: [
      { score: 0.62, disease: { id: 'EFO_0000311', name: 'cancer' } },
      { score: 0.41, disease: { id: 'MONDO_0005233', name: 'non-small cell lung carcinoma' } },
    ] },
    knownDrugs: { rows: [
      { drug: { id: 'CHEMBL1201585', name: 'EXAMPLEMAB' }, mechanismOfAction: 'CDCP1 inhibitor', phase: 1 },
    ] },
  } },
};
const fakeFetch = (async (_url, init) => {
  const body = JSON.parse(String((init as RequestInit).body));
  if (body.query.includes('mapIds') || body.variables?.q) {
    return new Response(JSON.stringify({ data: { search: { hits: [{ id: 'ENSG00000163814', entity: 'target' }] } } }), { status: 200 });
  }
  return new Response(JSON.stringify(payload), { status: 200 });
}) as unknown as typeof fetch;

describe('openTargetsTargetTool', () => {
  it('normalizes target + diseases + drugs to canonical evidence', async () => {
    const out = await openTargetsTargetTool.call({ symbol: 'CDCP1' }, fakeFetch);
    const target = out.find((e) => e.kind === 'target');
    expect(target?.id).toBe('ENSG00000163814');
    expect(out.filter((e) => e.kind === 'disease').map((e) => e.id)).toEqual(['EFO_0000311', 'MONDO_0005233']);
    expect(out.find((e) => e.kind === 'drug')?.id).toBe('CHEMBL1201585');
    // safety/tractability folded into the target record raw
    expect((target?.raw as { safetyLiabilities?: unknown[] }).safetyLiabilities).toHaveLength(1);
  });

  it('returns [] for an unresolved symbol', async () => {
    const empty = (async () => new Response(JSON.stringify({ data: { search: { hits: [] } } }), { status: 200 })) as unknown as typeof fetch;
    expect(await openTargetsTargetTool.call({ symbol: 'ZZZ' }, empty)).toHaveLength(0);
  });
});
