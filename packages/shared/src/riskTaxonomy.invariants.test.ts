import { describe, expect, it } from 'vitest';
import {
  ModalityRiskSchema,
  RISK_CODE_METADATA,
  RiskCodeSchema,
  RiskDomainSchema,
} from './index.js';

const support = { supportingClaimIds: ['c1'], evidenceIds: ['e1'] };
const validRisk = {
  id: 'risk-1',
  description: 'Off-target activity could narrow the therapeutic window.',
  category: { domain: 'safety', code: 'common.off_target_activity' },
  likelihood: 'low',
  severity: 'high',
  mitigability: 'design_manageable',
  confidence: 'moderate',
  support,
};

describe('controlled risk taxonomy invariants', () => {
  it('exposes exactly the ten risk domains', () => {
    expect(RiskDomainSchema.options).toEqual([
      'target_biology', 'safety', 'delivery_biodistribution', 'pk_pd',
      'resistance', 'immunogenicity', 'cmc', 'manufacturing',
      'clinical_operations', 'translational_model',
    ]);
  });

  it('keeps the RiskCode enum and metadata registry in one-to-one correspondence', () => {
    expect([...RiskCodeSchema.options].sort()).toEqual(Object.keys(RISK_CODE_METADATA).sort());
  });

  it('carries likelihood independently from severity', () => {
    const parsed = ModalityRiskSchema.parse(validRisk);
    expect(parsed.likelihood).toBe('low');
    expect(parsed.severity).toBe('high');
    expect(ModalityRiskSchema.parse({ ...validRisk, likelihood: 'high', severity: 'low' })).toMatchObject({
      likelihood: 'high', severity: 'low',
    });
  });

  it('rejects a risk code declared under the wrong domain', () => {
    expect(ModalityRiskSchema.safeParse({
      ...validRisk,
      category: { domain: 'cmc', code: 'common.off_target_activity' },
    }).success).toBe(false);
  });

  it('rejects unknown/free-form risk codes', () => {
    expect(ModalityRiskSchema.safeParse({
      ...validRisk,
      category: { domain: 'safety', code: 'model.invented_risk' },
    }).success).toBe(false);
  });

  it('requires a nonblank taxonomyNote for every common.other_* fallback', () => {
    const other = {
      ...validRisk,
      category: { domain: 'safety', code: 'common.other_safety' },
    };
    expect(ModalityRiskSchema.safeParse(other).success).toBe(false);
    expect(ModalityRiskSchema.safeParse({ ...other, taxonomyNote: '   ' }).success).toBe(false);
    expect(ModalityRiskSchema.safeParse({
      ...other, taxonomyNote: 'No controlled code describes complement activation.',
    }).success).toBe(true);
  });

  it('maps every common.other_* fallback to its declared domain', () => {
    expect(Object.fromEntries(
      Object.entries(RISK_CODE_METADATA)
        .filter(([code]) => code.startsWith('common.other_')),
    )).toEqual({
      'common.other_target_biology': { domain: 'target_biology' },
      'common.other_safety': { domain: 'safety' },
      'common.other_delivery': { domain: 'delivery_biodistribution' },
      'common.other_pk_pd': { domain: 'pk_pd' },
      'common.other_resistance': { domain: 'resistance' },
      'common.other_immunogenicity': { domain: 'immunogenicity' },
      'common.other_cmc': { domain: 'cmc' },
      'common.other_manufacturing': { domain: 'manufacturing' },
      'common.other_clinical_operations': { domain: 'clinical_operations' },
      'common.other_translational_model': { domain: 'translational_model' },
    });
  });
});
