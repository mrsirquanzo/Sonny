import { describe, expect, it } from 'vitest';
import { openTargetsTargetTool } from '../../mcp-gateway/src/openTargetsTarget.js';
import { uniProtTargetTool } from '../../mcp-gateway/src/uniProtTarget.js';

const FORBIDDEN =
  /\b(?:antibod(?:y|ies)|ADC|immunoconjugates?|bindability|small[- ]molecules?|PROTACs?|molecular glues?|siRNA|ASO|bispecific(?: antibody)?|CAR[- ]?T|TCR[- ]?T|gene edit(?:ing)?|gene replacement|mRNA|radioligands?|therapeutic vaccines?)\b/i;

function openTargetsFetch(target: Record<string, unknown>): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { variables?: { q?: string } };
    const body = request.variables?.q
      ? { data: { search: { hits: [{ id: 'ENSG_TEST', entity: 'target' }] } } }
      : { data: { target } };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

function uniProtFetch(entry: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ results: [entry] }), { status: 200 })) as unknown as typeof fetch;
}

function expectNeutral(snippet: string | undefined): void {
  expect(snippet).toBeTruthy();
  expect(snippet).not.toMatch(FORBIDDEN);
}

describe('curated target-card snippet neutrality', () => {
  it.each([
    {
      name: 'without a cell-surface annotation',
      symbol: 'KRAS',
      locations: [{ location: 'Cytoplasm' }, { location: 'Nucleus' }],
    },
    {
      name: 'with a cell-surface annotation',
      symbol: 'CDCP1',
      locations: [{ location: 'Cell membrane' }, { location: 'Plasma membrane' }],
    },
  ])('Open Targets reports facts $name without naming or recommending a modality', async ({ symbol, locations }) => {
    const out = await openTargetsTargetTool.call({ symbol }, openTargetsFetch({
      id: 'ENSG_TEST',
      approvedSymbol: symbol,
      approvedName: `${symbol} protein`,
      tractability: [],
      safetyLiabilities: [],
      subcellularLocations: locations,
      baselineExpression: { rows: [
        { median: 91, datatypeId: 'rna', tissueBiosample: { biosampleName: 'Liver' } },
        { median: 37, datatypeId: 'proteomics', tissueBiosample: { biosampleName: 'Lung' } },
      ] },
    }));

    const localization = out.find((card) => card.id.endsWith('#localization'));
    const expression = out.find((card) => card.id.endsWith('#expression'));
    expectNeutral(localization?.snippet);
    expectNeutral(expression?.snippet);
    for (const location of locations) expect(localization?.snippet).toContain(location.location);
    expect(expression?.snippet).toContain('Liver');
    expect(expression?.snippet).toContain('Lung');
  });

  it.each([
    {
      name: 'without a cell-surface annotation',
      symbol: 'KRAS',
      accession: 'P01116',
      location: 'Cytoplasm',
      features: [{ type: 'Domain', description: 'Small GTPase domain' }],
    },
    {
      name: 'with a cell-surface annotation',
      symbol: 'CDCP1',
      accession: 'Q9H5V8',
      location: 'Cell membrane',
      features: [
        { type: 'Transmembrane', description: 'Helical' },
        { type: 'Topological domain', description: 'Extracellular' },
        { type: 'Domain', description: 'CUB 1' },
      ],
    },
  ])('UniProt reports localization and domains $name without editorializing', async ({
    symbol, accession, location, features,
  }) => {
    const out = await uniProtTargetTool.call({ symbol }, uniProtFetch({
      primaryAccession: accession,
      comments: [{
        commentType: 'SUBCELLULAR LOCATION',
        subcellularLocations: [{ location: { value: location } }],
      }],
      features,
    }));

    const localization = out.find((card) => card.id.endsWith('#localization'));
    const domains = out.find((card) => card.id.endsWith('#domains'));
    expectNeutral(localization?.snippet);
    expect(localization?.snippet).toContain(location);
    if (domains) {
      expectNeutral(domains.snippet);
      expect(domains.snippet).toContain(
        (features.find((feature) => feature.type === 'Domain') as { description: string }).description,
      );
    }
  });
});
