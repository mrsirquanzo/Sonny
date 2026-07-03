import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { GoldenTarget } from './goldenSet.js';

const load = (f: string) => JSON.parse(readFileSync(new URL(`../golden/verdict/${f}`, import.meta.url), 'utf8'));

describe('GoldenTarget schema', () => {
  it('validates the CDCP1 golden target', () => {
    const t = GoldenTarget.parse(load('CDCP1.json'));
    expect(t.label).toBe('watch');
    expect(t.expectedKols.some((k) => k.investigator === 'Hooper JD' && k.mustAppear)).toBe(true);
  });

  it('validates the ZXQR7 trap and requires abstention in its band', () => {
    const t = GoldenTarget.parse(load('ZXQR7.trap.json'));
    expect(t.trap?.kind).toBe('fictional');
    expect(t.allowedVerdicts).toContain('insufficient-evidence');
  });

  it('rejects a target whose allowedVerdicts omits its label', () => {
    expect(() => GoldenTarget.parse({
      target: 'X', label: 'go', allowedVerdicts: ['watch'], rationale: 'r',
      curator: 'c', curatedAt: '2026-07-02',
    })).toThrow();
  });

  it('rejects a trap that does not allow insufficient-evidence', () => {
    expect(() => GoldenTarget.parse({
      target: 'X', label: 'watch', allowedVerdicts: ['watch'], rationale: 'r',
      trap: { kind: 'fictional', reason: 'r' }, curator: 'c', curatedAt: '2026-07-02',
    })).toThrow();
  });
});
