import { describe, expect, it } from 'vitest';
import {
  CRITICAL_RISK_DOMAINS_BY_MODALITY,
  CanonicalModalitySchema,
  RiskDomainSchema,
} from './index.js';

describe('critical risk domains by canonical modality', () => {
  it('matches the normative table exactly', () => {
    expect(CRITICAL_RISK_DOMAINS_BY_MODALITY).toEqual({
      adc: ['safety', 'target_biology', 'pk_pd', 'cmc'],
      monoclonal_antibody: ['safety', 'pk_pd', 'immunogenicity'],
      bispecific_antibody: ['safety', 'pk_pd', 'immunogenicity', 'cmc'],
      small_molecule: ['safety', 'pk_pd'],
      protac: ['safety', 'pk_pd', 'target_biology'],
      molecular_glue: ['safety', 'target_biology'],
      sirna: ['safety', 'delivery_biodistribution', 'pk_pd'],
      aso: ['safety', 'delivery_biodistribution', 'pk_pd'],
      car_t: ['safety', 'target_biology', 'manufacturing'],
      tcr_t: ['safety', 'target_biology', 'manufacturing', 'clinical_operations'],
      gene_editing: ['safety', 'delivery_biodistribution', 'manufacturing'],
      gene_replacement: ['safety', 'immunogenicity', 'delivery_biodistribution', 'manufacturing'],
      mrna: ['safety', 'immunogenicity', 'delivery_biodistribution', 'manufacturing'],
      radioligand: ['safety', 'delivery_biodistribution', 'manufacturing'],
      therapeutic_vaccine: ['immunogenicity', 'safety', 'clinical_operations'],
      unknown: ['safety'],
    });
  });

  it('has one entry for every CanonicalModality and no extra entries', () => {
    expect(Object.keys(CRITICAL_RISK_DOMAINS_BY_MODALITY).sort())
      .toEqual([...CanonicalModalitySchema.options].sort());
  });

  it('contains only controlled risk domains', () => {
    for (const domains of Object.values(CRITICAL_RISK_DOMAINS_BY_MODALITY)) {
      for (const domain of domains) {
        expect(RiskDomainSchema.safeParse(domain).success).toBe(true);
      }
    }
  });

  it('preserves the normative adc/small-molecule CMC distinction', () => {
    expect(CRITICAL_RISK_DOMAINS_BY_MODALITY.adc).toContain('cmc');
    expect(CRITICAL_RISK_DOMAINS_BY_MODALITY.small_molecule).not.toContain('cmc');
  });

  it('uses only safety as the conservative explicit fallback for unknown modality', () => {
    expect(CRITICAL_RISK_DOMAINS_BY_MODALITY.unknown).toEqual(['safety']);
  });
});
