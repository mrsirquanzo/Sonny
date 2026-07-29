import type { MondoTerm, OntologyIndex } from '../index.js';

type FixtureTerm = MondoTerm & {
  synonyms: string[];
  crossRefs: Array<{
    source: 'EFO' | 'DOID' | 'NCIT' | 'ORPHANET' | 'MESH';
    sourceId: string;
    mappingRelation: 'exact' | 'narrow' | 'broad' | 'related';
  }>;
};

const terms: FixtureTerm[] = [
  {
    ontologyId: 'MONDO:0005233',
    canonicalName: 'non-small cell lung carcinoma',
    synonyms: ['NSCLC', 'non-small-cell lung cancer'],
    crossRefs: [
      { source: 'EFO', sourceId: 'EFO:0003060', mappingRelation: 'exact' },
      { source: 'DOID', sourceId: 'DOID:3908', mappingRelation: 'exact' },
      { source: 'NCIT', sourceId: 'C2926', mappingRelation: 'exact' },
      { source: 'EFO', sourceId: 'EFO:BROAD_LUNG_CANCER', mappingRelation: 'broad' },
    ],
  },
  {
    ontologyId: 'MONDO:0005061',
    canonicalName: 'lung adenocarcinoma',
    synonyms: ['adenocarcinoma of lung'],
    crossRefs: [
      { source: 'DOID', sourceId: 'DOID:3910', mappingRelation: 'exact' },
      { source: 'NCIT', sourceId: 'C3512', mappingRelation: 'exact' },
      { source: 'EFO', sourceId: 'EFO:NARROW_LUNG_ADENO', mappingRelation: 'narrow' },
    ],
  },
  {
    ontologyId: 'MONDO:0006047',
    canonicalName: 'pancreatic ductal adenocarcinoma',
    synonyms: ['PDAC', 'pancreatic ductal carcinoma'],
    crossRefs: [
      { source: 'EFO', sourceId: 'EFO:0002618', mappingRelation: 'exact' },
      { source: 'DOID', sourceId: 'DOID:3498', mappingRelation: 'exact' },
    ],
  },
  {
    ontologyId: 'MONDO:0005105',
    canonicalName: 'melanoma',
    synonyms: ['malignant melanoma'],
    crossRefs: [
      { source: 'EFO', sourceId: 'EFO:0000756', mappingRelation: 'exact' },
      { source: 'DOID', sourceId: 'DOID:1909', mappingRelation: 'exact' },
    ],
  },
  {
    ontologyId: 'MONDO:0009061',
    canonicalName: 'cystic fibrosis',
    synonyms: ['CF', 'mucoviscidosis'],
    crossRefs: [
      { source: 'EFO', sourceId: 'EFO:0000341', mappingRelation: 'exact' },
      { source: 'DOID', sourceId: 'DOID:1485', mappingRelation: 'exact' },
    ],
  },
  {
    ontologyId: 'MONDO:0006256',
    canonicalName: 'triple-negative breast cancer',
    synonyms: ['TNBC', 'triple negative breast carcinoma'],
    crossRefs: [
      { source: 'EFO', sourceId: 'EFO:0005537', mappingRelation: 'exact' },
      { source: 'DOID', sourceId: 'DOID:0060081', mappingRelation: 'exact' },
    ],
  },
];

export const normalizeFixtureText = (value: string): string =>
  value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');

/**
 * Deliberately tiny, fully local stand-in for pinned MONDO. It covers the
 * Section 12.3 indications plus TNBC and the required parent-child case.
 */
export const ontologyFixture: OntologyIndex = {
  version: '2026-06-02',
  lookupExact(normalizedLabel) {
    return terms.find((term) => normalizeFixtureText(term.canonicalName) === normalizedLabel);
  },
  lookupSynonym(normalizedLabel) {
    return terms.filter((term) =>
      term.synonyms.some((synonym) => normalizeFixtureText(synonym) === normalizedLabel));
  },
  lookupCrossRef(source, sourceId) {
    const term = terms.find((candidate) =>
      candidate.crossRefs.some((crossRef) =>
        crossRef.source === source
        && normalizeFixtureText(crossRef.sourceId) === normalizeFixtureText(sourceId)));
    if (!term) return undefined;
    const crossRef = term.crossRefs.find((candidate) =>
      candidate.source === source
      && normalizeFixtureText(candidate.sourceId) === normalizeFixtureText(sourceId))!;
    return { ...term, mappingRelation: crossRef.mappingRelation };
  },
  ancestorsOf(mondoId) {
    return mondoId === 'MONDO:0005061' ? ['MONDO:0005233'] : [];
  },
};

